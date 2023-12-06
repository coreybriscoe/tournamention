import { CommandInteractionOption, EmbedBuilder, SlashCommandBuilder } from 'discord.js';
import { LimitedCommandInteraction } from '../../types/limitedCommandInteraction.js';
import { OutcomeStatus, Outcome, OptionValidationErrorOutcome, SlashCommandDescribedOutcome, SlashCommandEmbedDescribedOutcome } from '../../types/outcome.js';
import { SimpleRendezvousSlashCommand } from '../architecture/rendezvousCommand.js';
import { ValueOf } from '../../types/typelogic.js';
import { Constraint, validateConstraints, ALWAYS_OPTION_CONSTRAINT } from '../architecture/validation.js';
import { OptionValidationError } from '../../types/customError.js';
import { getCurrentTournament } from '../../backend/queries/guildSettingsQueries.js';
import { getCareerPointsOfContestant, getOrCreateContestant, getPointsOfContestantForTournament } from '../../backend/queries/profileQueries.js';
import { TournamentionClient } from '../../types/client.js';

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
enum ProfileSpecificStatus {
    SUCCESS_DETAILS = 'SUCCESS_DETAILS',
}

/**
 * Union of specific and generic status codes.
 */
type ProfileStatus = ProfileSpecificStatus | OutcomeStatus;

/**
 * The outcome format for the specific status code(s).
 */
type ProfileSuccessDetailsOutcome = {
    status: ProfileSpecificStatus.SUCCESS_DETAILS;
    body: {
        currentPoints: number;
        careerPoints: number;
        userDetails: {
            name: string;
            icon: string;
        }
    };
};

/**
 * Union of specific and generic outcomes.
 */
type ProfileSpecificOutcome = ProfileSuccessDetailsOutcome;

type ProfileOutcome = Outcome<T1, T2, ProfileSpecificOutcome>;

/**
 * Parameters for the solver function, as well as the "S" generic type.
 */
interface ProfileSolverParams {
    guildId: string;
    memberId: string;
}

const profileSolver = async (params: ProfileSolverParams): Promise<ProfileOutcome> => {
    try {
        const guild = (await TournamentionClient.getInstance()).guilds.fetch(params.guildId);
        const member = (await guild).members.fetch(params.memberId);
        const contestant = await getOrCreateContestant(params.guildId, params.memberId);

        const careerPoints = getCareerPointsOfContestant(contestant);

        const currentTournament = await getCurrentTournament(params.guildId);
        let currentPoints = new Promise<number>((resolve) => resolve(-1));
        if (currentTournament) currentPoints = getPointsOfContestantForTournament(contestant, currentTournament);

        return {
            status: ProfileSpecificStatus.SUCCESS_DETAILS,
            body: {
                currentPoints: (await currentPoints),
                careerPoints: (await careerPoints),
                userDetails: {
                    name: (await member).displayName,
                    icon: (await member).user.avatarURL() ?? 'https://static.wikia.nocookie.net/minecraft_gamepedia/images/0/02/Pointer_%28texture%29_JE1_BE1.png',
                },
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

const profileSlashCommandValidator = async (interaction: LimitedCommandInteraction): Promise<ProfileSolverParams | OptionValidationErrorOutcome<T1>> => {
    const metadataConstraints = new Map<keyof LimitedCommandInteraction, Constraint<ValueOf<LimitedCommandInteraction>>[]>([]);
    const optionConstraints = new Map<CommandInteractionOption | null | ALWAYS_OPTION_CONSTRAINT, Constraint<ValueOf<CommandInteractionOption>>[]>([]);

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
        memberId: interaction.options.get('user', false)?.user?.id as string ?? interaction.member!.user.id,
    };
};

const profileSlashCommandDescriptions = new Map<ProfileStatus, (o: ProfileOutcome) => SlashCommandDescribedOutcome | SlashCommandEmbedDescribedOutcome>([
    [ProfileSpecificStatus.SUCCESS_DETAILS, (o: ProfileOutcome) => {
        const oBody = (o as ProfileSuccessDetailsOutcome).body;
        return {
            embeds: [new EmbedBuilder()
                .setTitle(`${oBody.userDetails.name}'s Profile`)
                .setDescription(`**Current Points:** ${oBody.currentPoints}\n**Career Points:** ${oBody.careerPoints}`)
                .setThumbnail(oBody.userDetails.icon)
                .toJSON()
            ],
            ephemeral: true,
        } as SlashCommandEmbedDescribedOutcome;
    }],
]);

const ProfileCommand = new SimpleRendezvousSlashCommand<ProfileOutcome, ProfileSolverParams, T1, ProfileStatus>(
    new SlashCommandBuilder()
        .setName('profile')
        .setDescription('Show your Tournamention profile, or view another\'s profile.')
        .addUserOption(option => option.setName('user').setDescription('The tournament to view. Defaults to current tournament.').setRequired(false)) as SlashCommandBuilder,
    profileSlashCommandDescriptions,
    profileSlashCommandValidator,
    profileSolver,
);

export default ProfileCommand;