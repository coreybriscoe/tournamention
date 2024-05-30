import { SlashCommandBuilder } from '@discordjs/builders';
import { EmbedBuilder, GuildMember, PermissionsBitField } from 'discord.js';
import { getTournamentsByGuild } from '../../backend/queries/tournamentQueries.js';
import { ResolvedTournament, TournamentDocument, resolveTournaments } from '../../types/customDocument.js';
import { getCurrentTournament } from '../../backend/queries/guildSettingsQueries.js';
import { ValueOf } from '../../types/typelogic.js';
import { getJudgeByGuildIdAndMemberId } from '../../backend/queries/profileQueries.js';
import { RendezvousClient as TournamentionClient, OutcomeStatus, Outcome, LimitedCommandInteraction, OptionValidationErrorOutcome, Constraint, LimitedCommandInteractionOption, validateConstraints, OptionValidationError, SlashCommandDescribedOutcome, SlashCommandEmbedDescribedOutcome, SimpleRendezvousSlashCommand } from 'discord-rendezvous';

/**
 * Alias for the first generic type of the command.
 */
type T1 = ResolvedTournament;

/**
 * Alias for the second generic type of the command.
 */
type T2 = void;

/**
 * Status codes specific to this command.
 */
enum TournamentsSpecificStatus {
    SUCCESS_DETAILS = 'SUCCESS_DETAILS',
}

/**
 * Union of specific and generic status codes.
 */
type TournamentsStatus = TournamentsSpecificStatus | OutcomeStatus;

/**
 * The outcome format for the specific status code(s).
 */
type TournamentsSuccessDetailsOutcome = {
    status: TournamentsSpecificStatus.SUCCESS_DETAILS,
    body: {
        current: T1 | null,
        currentIsHidden: boolean,
        active: T1[],
        inactive: T1[],
        serverDetails: {
            name: string,
            icon: string,
        },
    }
};

/**
 * Union of specific and generic outcomes.
 */
type TournamentsOutcome = Outcome<T1, T2, TournamentsSuccessDetailsOutcome>;

/**
 * Parameters for the solver function, as well as the "S" generic type.
 */
interface TournamentsSolverParams {
    guildId: string;
    judgeView: boolean;
}

/**
 * Retrieves all the tournaments for a given guild.
 * @param guildId The Discord Guild ID.
 * @param judgeView True iff the output will be shown to a Judge/Admin.
 * @returns A `TournamentsOutcome`, in all cases.
 */
const tournamentsSolver = async (params: TournamentsSolverParams): Promise<TournamentsOutcome> => {
    try {
        const guild = (await TournamentionClient.getInstance()).guilds.fetch(params.guildId);
        const allTournaments = await getTournamentsByGuild(params.guildId);
        if (!allTournaments) return {
            status: OutcomeStatus.FAIL,
            body: {},
        };

        const currentTournament = await getCurrentTournament(params.guildId);
        const current = currentTournament ? (await resolveTournaments([currentTournament]))[0] : null;
        const currentIsHidden = currentTournament && !params.judgeView && !currentTournament.visibility;
        const activeTournaments = new Array<TournamentDocument>();
        const inactiveTournaments = new Array<TournamentDocument>();
        for (const tournament of allTournaments) {
            if (!params.judgeView && !tournament.visibility) continue;
            if (tournament.active) {
                if (current && tournament._id.equals(current._id)) continue;
                activeTournaments.push(tournament);
            } else inactiveTournaments.push(tournament);
        }
        const active = resolveTournaments(activeTournaments);
        const inactive = resolveTournaments(inactiveTournaments);

        const serverDetails = {
            name: (await guild).name,
            icon: (await guild).iconURL() ?? 'https://static.wikia.nocookie.net/minecraft_gamepedia/images/0/02/Pointer_%28texture%29_JE1_BE1.png',
        };

        return {
            status: TournamentsSpecificStatus.SUCCESS_DETAILS,
            body: {
                current,
                currentIsHidden,
                active: await active,
                inactive: await inactive,
                serverDetails,
            },
        } as TournamentsSuccessDetailsOutcome;
    } catch (err) {
        // No expected thrown errors
    }

    return ({
        status: OutcomeStatus.FAIL_UNKNOWN,
        body: {},
    });
};

const tournamentsSlashCommandValidator = async (interaction: LimitedCommandInteraction): Promise<TournamentsSolverParams | OptionValidationErrorOutcome<T1>> => {
    // Validator for this command has the unique responsibility of determining whether to call
    // business logic method for Judge/Admin or Contestant data
    const guildId = interaction.guildId!;

    const metadataConstraints = new Map<keyof LimitedCommandInteraction, Constraint<ValueOf<LimitedCommandInteraction>>[]>([]);
    const optionConstraints = new Map<LimitedCommandInteractionOption | null, Constraint<ValueOf<LimitedCommandInteractionOption>>[]>([]);

    const judge = await getJudgeByGuildIdAndMemberId(guildId, (interaction.member as GuildMember).id);
    const memberIsJudgeOrAdmin = (judge && judge.isActiveJudge) || (interaction.member as GuildMember).permissions.has(PermissionsBitField.Flags.Administrator);
    // contestantView is True iff user supplies True.
    // judgeView <=> !contestantView && memberIsJudgeOrAdmin
    let contestantView: boolean;
    try {
        contestantView = interaction.options.get('contestantview', false)?.value as boolean ?? false;

        await validateConstraints(interaction, metadataConstraints, optionConstraints);
    } catch (err) {
        if (err instanceof OptionValidationError) return {
            status: OutcomeStatus.FAIL_VALIDATION,
            body: {
                constraint: err.constraint,
                field: err.field,
                value: err.value,
                context: err.message,
            },
        };

        throw err;
    }

    const judgeView = !contestantView && memberIsJudgeOrAdmin;

    return {
        guildId: guildId,
        judgeView: judgeView,
    };
};

/**
 * Converts a ResolvedTournament to a string of a 2-line format.
 * @param tournament 
 * @returns A string with the format:
 * 
 * **My Tournament** (5 challenges: 2 🔥 1 💀)
 * 
 * {status description} ({duration})
 */
export const formatTournamentDetails = (tournament: ResolvedTournament): string => {
    // **My Tournament** (5 challenges
    let message = `**${tournament.name}** (${tournament.challenges.length} ${tournament.challenges.length !== 1 ? 'challenges' : 'challenge'}`;
    // :
    if (tournament.challenges.some(challenge => challenge.difficulty)) message += ':';
    // 2 🔥 1 💀
    for (const difficulty of tournament.difficulties) {
        const challengesOfDifficultCount = tournament.challenges.filter(challenge => challenge.difficulty?._id.equals(difficulty._id)).length;
        if (challengesOfDifficultCount > 0) message += ` ${challengesOfDifficultCount} ${difficulty.emoji}`;
    }
    // )
    message += ')';
    if (!tournament.visibility) message += ' (💭 hidden)';
    // {status description} ({duration})
    message += `\n\t*${tournament.statusDescription || '(no description)'}* (${tournament.duration || 'no duration'})`;

    return message;
};

const tournamentsSlashCommandDescriptions = new Map<TournamentsStatus, (o: TournamentsOutcome) => SlashCommandDescribedOutcome | SlashCommandEmbedDescribedOutcome>([
    [TournamentsSpecificStatus.SUCCESS_DETAILS, (o: TournamentsOutcome) => {
        const oBody = (o as TournamentsSuccessDetailsOutcome).body;
        let message = '';
        if (!oBody.current) {
            message += `There is no current tournament.`;
        } else if (oBody.currentIsHidden) {
            message += `The current tournament is *hidden*.`;
        } else {
            message += `The current tournament:\n${formatTournamentDetails(oBody.current!)}`;
        }
        if (oBody.active.length > 0) {
            message += oBody.currentIsHidden ? `\n\nActive tournaments:` : `\n\nOther active tournaments:`;
            oBody.active.forEach((tournament: ResolvedTournament) => {
                message += `\n${formatTournamentDetails(tournament)}`;
            });
        }
        if (oBody.inactive.length > 0) {
            message += `\n\nInactive tournaments:`;
            oBody.inactive.forEach((tournament: ResolvedTournament) => {
                message += `\n${formatTournamentDetails(tournament)}`;
            });
        }
        return {
            embeds: [new EmbedBuilder()
                .setTitle(`Tournaments in ${oBody.serverDetails.name}`)
                .setDescription(message)
                .setThumbnail(oBody.serverDetails.icon)
                .toJSON()
            ],
            ephemeral: true,
        } as SlashCommandEmbedDescribedOutcome;
    }],
    [OutcomeStatus.FAIL, (_: TournamentsOutcome) => ({
        userMessage: 'There were no tournaments found in this server.', ephemeral: true,
    })],
]);

const TournamentsCommand = new SimpleRendezvousSlashCommand<TournamentsOutcome, TournamentsSolverParams, T1, TournamentsStatus>(
    new SlashCommandBuilder()
        .setName('tournaments')
        .setDescription('Show the tournaments happening in the server.')
        .addBooleanOption(option => option.setName('contestantview').setDescription('Judges can use True to only show visible tournaments, to see what a contestant sees.').setRequired(false)) as SlashCommandBuilder,
    tournamentsSlashCommandDescriptions,
    tournamentsSlashCommandValidator,
    tournamentsSolver,
);

export default TournamentsCommand;