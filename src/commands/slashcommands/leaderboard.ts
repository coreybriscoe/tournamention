import { EmbedBuilder, SlashCommandBuilder } from 'discord.js';
import { ValueOf } from '../../types/typelogic.js';
import { getCurrentTournament } from '../../backend/queries/guildSettingsQueries.js';
import { ResolvedTournament } from '../../types/customDocument.js';
import { getTournamentByName } from '../../backend/queries/tournamentQueries.js';
import { getLeaderboard } from '../../backend/queries/profileQueries.js';
import { RendezvousClient as TournamentionClient, OutcomeStatus, Outcome, LimitedCommandInteraction, OptionValidationErrorOutcome, Constraint, LimitedCommandInteractionOption, ALWAYS_OPTION_CONSTRAINT, OptionValidationErrorStatus, validateConstraints, OptionValidationError, SlashCommandDescribedOutcome, SlashCommandEmbedDescribedOutcome, SimpleRendezvousSlashCommand } from 'discord-rendezvous';

/**
 * Alias for the first generic type of the command.
 */
type T1 = string;

/**
 * Alias for the second generic type of the command.
 */
type T2 = void;

/**
 * Status codes specific to this command.
 */
enum LeaderboardSpecificStatus {
    SUCCESS_DETAILS = 'SUCCESS_DETAILS',
}

/**
 * Union of specific and generic status codes.
 */
type LeaderboardStatus = LeaderboardSpecificStatus | OutcomeStatus;

type LeaderboardContestant = {
    memberId: string;
    points: number;
    highlight: boolean;
};

type LeaderboardSuccessDetailsBody = {
    contestants: LeaderboardContestant[];
    tournament: ResolvedTournament;
    serverDetails: {
        name: string;
        icon: string;
    };
};

/**
 * The outcome format for the specific status code(s).
 */
type LeaderboardSuccessDetailsOutcome = {
    status: LeaderboardSpecificStatus.SUCCESS_DETAILS;
    body: LeaderboardSuccessDetailsBody;
};

/**
 * Union of specific and generic outcomes.
 */
type LeaderboardSpecificOutcome = LeaderboardSuccessDetailsOutcome;

type LeaderboardOutcome = Outcome<T1, T2, LeaderboardSpecificOutcome>;

/**
 * Parameters for the solver function, as well as the "S" generic type.
 */
interface LeaderboardSolverParams {
    guildId: string;
    tournament?: string | undefined;
    highlightedMember?: string | undefined;
}

const leaderboardSolver = async (params: LeaderboardSolverParams): Promise<LeaderboardOutcome> => {
    try {
        const guild = (await TournamentionClient.getInstance()).guilds.fetch(params.guildId);
        const tournamentDocument = params.tournament ? await getTournamentByName(params.guildId, params.tournament) : await getCurrentTournament(params.guildId);
        const contestants = (await getLeaderboard(params.guildId, tournamentDocument!))
            .map((contestant, _): LeaderboardContestant => ({
                memberId: contestant.userId,
                points: contestant.points,
                highlight: contestant.userId === params.highlightedMember,
            }));

        const serverDetails = {
            name: (await guild).name,
            icon: (await guild).iconURL() ?? 'https://static.wikia.nocookie.net/minecraft_gamepedia/images/0/02/Pointer_%28texture%29_JE1_BE1.png',
        };
        
        return {
            status: LeaderboardSpecificStatus.SUCCESS_DETAILS,
            body: {
                contestants,
                tournament: await new ResolvedTournament(tournamentDocument!).make(),
                serverDetails,
            },
        };
    } catch (err) {
        // No expected thrown errors
    }

    return {
        status: OutcomeStatus.FAIL_UNKNOWN,
        body: {},
    };
};

const leaderboardSlashCommandValidator = async (interaction: LimitedCommandInteraction): Promise<LeaderboardSolverParams | OptionValidationErrorOutcome<T1>> => {
    const guildId = interaction.guildId!;
    const tournament = interaction.options.get('tournament', false);

    const metadataConstraints = new Map<keyof LimitedCommandInteraction, Constraint<ValueOf<LimitedCommandInteraction>>[]>([]);
    const optionConstraints = new Map<LimitedCommandInteractionOption | null | ALWAYS_OPTION_CONSTRAINT, Constraint<ValueOf<LimitedCommandInteractionOption>>[]>([
        [tournament, [
            // Ensure that the tournament exists, if it was provided
            {
                category: OptionValidationErrorStatus.OPTION_DNE,
                func: async function(option: ValueOf<LimitedCommandInteractionOption>): Promise<boolean> {
                    const tournamentDocument = await getTournamentByName(guildId, option as string);
                    return tournamentDocument !== null;
                }
            },
        ]],
        ['ALWAYS_OPTION_CONSTRAINT', [
            // Ensure that either the specified Tournament exists (seemingly redundantly) or there is a current Tournament
            {
                category: OptionValidationErrorStatus.OPTION_UNDEFAULTABLE,
                func: async function(_: ValueOf<LimitedCommandInteractionOption>): Promise<boolean> {
                    const tournamentDocument = tournament ? await getTournamentByName(guildId, tournament.value as string) : await getCurrentTournament(guildId);
                    return tournamentDocument !== null;
                },
            },
        ]],
    ]);

    try {
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

    return {
        guildId: interaction.guildId as string,
        tournament: tournament?.value as string | undefined,
        highlightedMember: interaction.member?.user.id,
    };
};

const formatLeaderboardDetails = (solverResultBody: LeaderboardSuccessDetailsBody): string => {
    let result = '';
    let rank = 1;
    for (const contestant of solverResultBody.contestants) {
        result += `${contestant.highlight ? '**' : ''}${rank++}. <@${contestant.memberId}> - ${contestant.points} point${contestant.points !== 1 ? 's' : ''}${contestant.highlight ? '**' : ''}\n`;
    }
    return result || 'No submissions have been approved yet.';
};

const leaderboardSlashCommandDescriptions = new Map<LeaderboardStatus, (o: LeaderboardOutcome) => SlashCommandDescribedOutcome | SlashCommandEmbedDescribedOutcome>([
    [LeaderboardSpecificStatus.SUCCESS_DETAILS, (o: LeaderboardOutcome) => {
        const oBody = (o as LeaderboardSuccessDetailsOutcome).body;
        return {
            embeds: [new EmbedBuilder()
                .setTitle(`Leaderboard for **${oBody.tournament.name}**`)
                .setDescription(formatLeaderboardDetails(oBody))
                .setThumbnail(oBody.serverDetails.icon)
                .toJSON()
            ],
            ephemeral: true,
        } as SlashCommandEmbedDescribedOutcome;
    }],
]);

const LeaderboardCommand = new SimpleRendezvousSlashCommand<LeaderboardOutcome, LeaderboardSolverParams, T1, LeaderboardStatus>(
    new SlashCommandBuilder()
        .setName('leaderboard')
        .setDescription('View the Tournamention leaderboard for this server.')
        .addStringOption(option => option.setName('tournament').setDescription('The tournament to view. Defaults to current tournament.').setRequired(false)) as SlashCommandBuilder,
    leaderboardSlashCommandDescriptions,
    leaderboardSlashCommandValidator,
    leaderboardSolver,
    true,
);

export default LeaderboardCommand;