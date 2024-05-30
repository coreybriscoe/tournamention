import { SlashCommandBuilder } from '@discordjs/builders';
import { GuildMember, PermissionsBitField } from 'discord.js';
import { createDifficultyInTournament, getDifficultyByEmoji, getTournamentByName, isSingleEmoji } from '../../backend/queries/tournamentQueries.js';
import { getCurrentTournament } from '../../backend/queries/guildSettingsQueries.js';
import { getJudgeByGuildIdAndMemberId } from '../../backend/queries/profileQueries.js';
import { ValueOf } from '../../types/typelogic.js';
import { OutcomeStatus, Outcome, LimitedCommandInteraction, OptionValidationErrorOutcome, Constraint, OptionValidationErrorStatus, LimitedCommandInteractionOption, validateConstraints, OptionValidationError, SlashCommandDescribedOutcome, SimpleRendezvousSlashCommand } from 'discord-rendezvous';

/**
 * Alias for the first generic type of the command.
 */
type T1 = string;

/**
 * Alias for the second generic type of the command.
 */
type T2 = {
    emoji: string,
    pointValue: number,
};

/**
 * Status codes specific to this command.
 */
enum CreateDifficultySpecificStatus {
    SUCCESS_DIFFICULTY_CREATED = 'SUCCESS_DIFFICULTY_CREATED',
}

/**
 * Union of specific and generic status codes.
 */
type CreateDifficultyStatus = CreateDifficultySpecificStatus | OutcomeStatus;

/**
 * The outcome format for the specific status code(s).
 */
type CreateDifficultySpecificOutcome = {
    status: CreateDifficultySpecificStatus.SUCCESS_DIFFICULTY_CREATED;
    body: {
        data1: T1;
        context1: string;
        data2: T2;
        context2: string;
    };
}

/**
 * Union of specific and generic outcomes.
 */
type CreateDifficultyOutcome = Outcome<T1, T2, CreateDifficultySpecificOutcome>;

/**
 * Parameters for the solver function, as well as the "S" generic type.
 */

interface CreateDifficultySolverParams {
    guildId: string,
    emoji: string,
    pointValue: number,
    tournamentName?: string | undefined,
}

/**
 * Creates a Difficulty in a Tournament.
 * @param params The parameters object for the solver function.
 * @returns A `CreateDifficultyOutcome`, in all cases.
 */
const createDifficultySolver = async (params: CreateDifficultySolverParams): Promise<CreateDifficultyOutcome> => {
    try {
        const tournament = params.tournamentName ? await getTournamentByName(params.guildId, params.tournamentName) : await getCurrentTournament(params.guildId);

        const difficulty = await createDifficultyInTournament(tournament!, params.emoji, params.pointValue);
        if (!difficulty) return {
            status: OutcomeStatus.FAIL_UNKNOWN,
            body: {},
        };
        return {
            status: CreateDifficultySpecificStatus.SUCCESS_DIFFICULTY_CREATED,
            body: {
                data1: tournament!.name,
                context1: 'tournament',
                data2: {
                    emoji: difficulty.emoji,
                    pointValue: difficulty.pointValue,
                },
                context2: 'difficulty',
            }
        };
    } catch (err) {
        // No expected thrown errors
    }

    return {
        status: OutcomeStatus.FAIL_UNKNOWN,
        body: {},
    };
};

const createDifficultySlashCommandValidator = async (interaction: LimitedCommandInteraction): Promise<CreateDifficultySolverParams | OptionValidationErrorOutcome<T1>> => {
    const guildId = interaction.guildId!;
    const emoji = interaction.options.get('emoji', true);
    const pointValue = interaction.options.get('point-value', true);

    const metadataConstraints = new Map<keyof LimitedCommandInteraction, Constraint<ValueOf<LimitedCommandInteraction>>[]>([
        ['member', [
            // Ensure that the sender is a Judge or Administrator
            {
                category: OptionValidationErrorStatus.INSUFFICIENT_PERMISSIONS,
                func: async function(metadata: ValueOf<LimitedCommandInteraction>): Promise<boolean> {
                    const judge = await getJudgeByGuildIdAndMemberId(guildId, (metadata as GuildMember).id);
                    return (judge && judge.isActiveJudge) || (metadata as GuildMember).permissions.has(PermissionsBitField.Flags.Administrator);
                },
            },
        ]],
    ]);

    const tournament = interaction.options.get('tournament', false);

    const optionConstraints = new Map<LimitedCommandInteractionOption | null, Constraint<ValueOf<LimitedCommandInteractionOption>>[]>([
        [tournament, [
            // Ensure that the tournament exists, if it was provided
            // This occurs before UNDEFAULTABLE constraint to discriminate the case of a nonexistent
            // specified tournament name for the sake of the user feedback message
            {
                category: OptionValidationErrorStatus.OPTION_DNE,
                func: async function(option: ValueOf<LimitedCommandInteractionOption>): Promise<boolean> {
                    const tournamentDocument = await getTournamentByName(guildId, option as string);
                    return tournamentDocument !== null;
                }
            },
        ]],
        // Remaining checks have SOME tournament as a precondition, whether the selected or default
        // In-order constraints ensure this is validated first
        [emoji, [
            // Ensure that either the specified Tournament exists or there is a current Tournament
            // This constraint hijacks the required option emoji and does not use its value
            {
                category: OptionValidationErrorStatus.OPTION_UNDEFAULTABLE,
                func: async function(_: ValueOf<LimitedCommandInteractionOption>): Promise<boolean> {
                    const tournamentDocument = tournament ? await getTournamentByName(guildId, tournament.value as string) : await getCurrentTournament(guildId);
                    return tournamentDocument !== null;
                },
            },
            // Ensure that the emoji is a single emoji
            {
                category: OptionValidationErrorStatus.OPTION_INVALID,
                func: async function(option: ValueOf<LimitedCommandInteractionOption>): Promise<boolean> {
                    return isSingleEmoji(option as string);
                },
            },
            // Ensure that the emoji is not already a difficulty in the specified Tournament
            {
                category: OptionValidationErrorStatus.OPTION_DUPLICATE,
                func: async function(option: ValueOf<LimitedCommandInteractionOption>): Promise<boolean> {
                    const tournamentDocument = tournament ? await getTournamentByName(guildId, tournament.value as string) : await getCurrentTournament(guildId);
                    return (await getDifficultyByEmoji(tournamentDocument!, option as string)) === null;
                },
            },
        ]],
        [pointValue, [
            // Ensure that the point value is a non-negative integer
            {
                category: OptionValidationErrorStatus.NUMBER_BEYOND_RANGE,
                func: async function(option: ValueOf<LimitedCommandInteractionOption>): Promise<boolean> {
                    return (option as number) >= 0;
                },
            },
        ]],
    ]);

    try {
        await validateConstraints(interaction, metadataConstraints, optionConstraints);
    } catch (err) {
        if (err instanceof OptionValidationError) return ({
            status: OutcomeStatus.FAIL_VALIDATION,
            body: {
                constraint: err.constraint,
                field: err.field,
                value: err.value,
                context: err.message,
            },
        });

        throw err;
    }

    return {
        guildId: guildId,
        emoji: emoji.value as string,
        pointValue: pointValue.value as number,
        tournamentName: tournament ? tournament.value as string : undefined,
    };
};

const createDifficultySlashCommandDescriptions = new Map<CreateDifficultyStatus, (o: CreateDifficultyOutcome) => SlashCommandDescribedOutcome>([
    [CreateDifficultySpecificStatus.SUCCESS_DIFFICULTY_CREATED, (o: CreateDifficultyOutcome) => {
        const oBody = (o as CreateDifficultySpecificOutcome).body;
        return {
            userMessage: `✅ Difficulty ${oBody.data2.emoji} created in tournament **${oBody.data1}**.`, ephemeral: true,
        };
    }],
    [OutcomeStatus.FAIL_VALIDATION, (o: CreateDifficultyOutcome) => {
        const oBody = (o as OptionValidationErrorOutcome<T1>).body;
        if (oBody.constraint.category === OptionValidationErrorStatus.INSUFFICIENT_PERMISSIONS) return {
            userMessage: `❌ You do not have permission to use this command.`, ephemeral: true,
        };
        else if (oBody.constraint.category === OptionValidationErrorStatus.OPTION_INVALID) return {
            userMessage: `❌ What you entered for the emoji, **${oBody.value}**, is not a single emoji.`, ephemeral: true,
        };
        else if (oBody.constraint.category === OptionValidationErrorStatus.NUMBER_BEYOND_RANGE) return {
            userMessage: `❌ The point value provided, **${oBody.value}**, must be a non-negative integer.`, ephemeral: true,
        };
        else if (oBody.constraint.category === OptionValidationErrorStatus.OPTION_DNE) return {
            userMessage: `❌ The ${oBody.field} **${oBody.value}** was not found.`, ephemeral: true,
        };
        else if (oBody.constraint.category === OptionValidationErrorStatus.OPTION_UNDEFAULTABLE) return {
            userMessage: `❌ There is no current tournament. You must either specify a tournament by name or activate a tournament, then try again.`, ephemeral: true,
        };
        else if (oBody.constraint.category === OptionValidationErrorStatus.OPTION_DUPLICATE) return {
            userMessage: `❌ A difficulty with the emoji ${oBody.value} already exists in the tournament.`, ephemeral: true,
        };
        else return {
            userMessage: `❌ This command failed due to a validation error.`, ephemeral: true,
        };
    }],
]);

const CreateDifficultyCommand = new SimpleRendezvousSlashCommand<CreateDifficultyOutcome, CreateDifficultySolverParams, T1, CreateDifficultyStatus>(
    new SlashCommandBuilder()
        .setName('create-difficulty')
        .setDescription('Create a difficulty rating for challenges within one tournament.')
        .addStringOption(option => option.setName('emoji').setDescription('An emoji identifying the difficulty.').setRequired(true))
        .addIntegerOption(option => option.setName('point-value').setDescription('The number of points earned by completing the challenge.').setRequired(true))
        .addStringOption(option => option.setName('tournament').setDescription('The tournament the difficulty is part of. Defaults to current tournament.').setRequired(false)) as SlashCommandBuilder,
    createDifficultySlashCommandDescriptions,
    createDifficultySlashCommandValidator,
    createDifficultySolver,
);

export default CreateDifficultyCommand;