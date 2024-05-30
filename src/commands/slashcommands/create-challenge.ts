import { SlashCommandBuilder } from '@discordjs/builders';
import { GuildMember, PermissionsBitField } from 'discord.js';
import { addChallengeToTournament, getDifficultyByEmoji, getTournamentByName } from '../../backend/queries/tournamentQueries.js';
import { ChallengeDocument } from '../../types/customDocument.js';
import { ChallengeModel } from '../../backend/schemas/challenge.js';
import { getCurrentTournament } from '../../backend/queries/guildSettingsQueries.js';
import { ValueOf } from '../../types/typelogic.js';
import { getJudgeByGuildIdAndMemberId } from '../../backend/queries/profileQueries.js';
import config from '../../config.js';
import { Constraint, LimitedCommandInteraction, LimitedCommandInteractionOption, OptionValidationError, OptionValidationErrorOutcome, OptionValidationErrorStatus, Outcome, OutcomeStatus, OutcomeWithDuoBody, SimpleRendezvousSlashCommand, SlashCommandDescribedOutcome, validateConstraints } from 'discord-rendezvous';

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
enum _CreateChallengeSpecificStatus {

}

/**
 * Union of specific and generic status codes.
 */
type CreateChallengeStatus = OutcomeStatus;


/**
 * Union of specific and generic outcomes.
 */
type CreateChallengeOutcome = Outcome<T1, T2>;

/**
 * Parameters for the solver function, as well as the "S" generic type.
 */
interface CreateChallengeSolverParams {
    guildId: string;
    challengeName: string;
    game: string;
    description: string;
    visible: boolean;
    tournamentName?: string | undefined;
    difficulty?: string | undefined;
}

/**
 * Creates a single Challenge and adds it to a Tournament.
 * @param params The parameters object for the solver function.
 * @returns A CreateChallengeOutcome, in all cases.
 */
const createChallengeSolver = async (params: CreateChallengeSolverParams): Promise<CreateChallengeOutcome> => {
    try {
        // Ensure the Tournament and Difficulty exists
        const tournament = params.tournamentName ? await getTournamentByName(params.guildId, params.tournamentName) : await getCurrentTournament(params.guildId);

        // Create the challenge
        const challenge = await ChallengeModel.create({
            name: params.challengeName,
            description: params.description,
            game: params.game,
            difficulty: params.difficulty ? (await getDifficultyByEmoji(tournament!, params.difficulty))!._id : null,
            visibility: params.visible ?? false,
        });

        // Add the challenge to the tournament
        await addChallengeToTournament(tournament!, challenge);

        return ({
            status: OutcomeStatus.SUCCESS_DUO,
            body: {
                data1: challenge.name,
                context1: 'challengeName',
                data2: tournament!.name,
                context2: 'tournamentName',
            },
        });
    } catch (err) {
        // No expected thrown errors
    }

    return ({
        status: OutcomeStatus.FAIL_UNKNOWN,
        body: {},
    });
};

const createChallengeSlashCommandValidator = async (interaction: LimitedCommandInteraction): Promise<CreateChallengeSolverParams | OptionValidationErrorOutcome<T1>> => {
    const guildId = interaction.guildId!;

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

    const challengeName = interaction.options.get('name', true);
    const game = interaction.options.get('game', true);
    const description = interaction.options.get('description', true);
    const tournament = interaction.options.get('tournament', false);
    const difficulty = interaction.options.get('difficulty', false);

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
        [challengeName, [
            // Ensure challenge name is <= 40 characters
            {
                category: OptionValidationErrorStatus.OPTION_TOO_LONG,
                func: async function(option: ValueOf<LimitedCommandInteractionOption>): Promise<boolean> {
                    return (option as string).length <= config.fieldCharacterLimits.challengeName;
                },
            },
            // Ensure that either the specified Tournament exists or there is a current Tournament
            // This constraint hijacks the required option challengeName and does not use its value
            {
                category: OptionValidationErrorStatus.OPTION_UNDEFAULTABLE,
                func: async function(_: ValueOf<LimitedCommandInteractionOption>): Promise<boolean> {
                    const tournamentDocument = tournament ? await getTournamentByName(guildId, tournament.value as string) : await getCurrentTournament(guildId);
                    return tournamentDocument !== null;
                },
            },
            // Ensure that the Challenge name is unique for the Tournament
            {
                category: OptionValidationErrorStatus.OPTION_DUPLICATE,
                func: async function(option: ValueOf<LimitedCommandInteractionOption>): Promise<boolean> {
                    const tournamentDocument = tournament ? await getTournamentByName(guildId, tournament.value as string) : await getCurrentTournament(guildId);
                    if (!tournamentDocument) return false;
                    const tournamentChallenges = await tournamentDocument.get('resolvingChallenges') as ChallengeDocument[];
                    return !(tournamentChallenges.some((challenge: ChallengeDocument) => challenge.name === option as string));
                },
            },
        ]],
        [game, [
            // Ensure game name is <= 30 characters
            {
                category: OptionValidationErrorStatus.OPTION_TOO_LONG,
                func: async function(option: ValueOf<LimitedCommandInteractionOption>): Promise<boolean> {
                    return (option as string).length <= config.fieldCharacterLimits.game;
                },
            },
        ]],
        [description, [
            // Ensure description is <= 300 characters
            {
                category: OptionValidationErrorStatus.OPTION_TOO_LONG,
                func: async function(option: ValueOf<LimitedCommandInteractionOption>): Promise<boolean> {
                    return (option as string).length <= config.fieldCharacterLimits.challengeDescription;
                },
            },
        ]],
        [difficulty, [
            // Ensure that the difficulty exists, if it was provided
            {
                category: OptionValidationErrorStatus.OPTION_DNE,
                func: async function(option: ValueOf<LimitedCommandInteractionOption>): Promise<boolean> {
                    const tournamentDocument = tournament ? await getTournamentByName(guildId, tournament.value as string) : await getCurrentTournament(guildId);
                    if (!tournamentDocument) return false;
                    const difficultyDocument = await getDifficultyByEmoji(tournamentDocument, option as string);
                    return difficultyDocument !== null;
                }
            },
        ]],
    ]);

    let visible: boolean;
    try {
        visible = interaction.options.get('visible', false)?.value !== undefined ? interaction.options.get('visible', false)?.value as boolean : true;

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
        challengeName: challengeName.value as string,
        game: game.value as string,
        description: description.value as string,
        visible: visible,
        tournamentName: tournament ? tournament.value as string : undefined,
        difficulty: difficulty ? difficulty.value as string : undefined,
    };
};

const createChallengeSlashCommandDescriptions = new Map<CreateChallengeStatus, (o: CreateChallengeOutcome) => SlashCommandDescribedOutcome>([
    [OutcomeStatus.SUCCESS_DUO, (o: CreateChallengeOutcome) => ({
        userMessage: `✅ The challenge **${(o as OutcomeWithDuoBody<T1>).body.data1}** was added to tournament **${(o as OutcomeWithDuoBody<T1>).body.data2}**.`, ephemeral: true,
    })],
    [OutcomeStatus.FAIL_VALIDATION, (o: CreateChallengeOutcome) => {
        const oBody = (o as OptionValidationErrorOutcome<T1>).body;
        if (oBody.constraint.category === OptionValidationErrorStatus.INSUFFICIENT_PERMISSIONS) return ({
            userMessage: `❌ You do not have permission to use this command.`, ephemeral: true,
        });
        else if (oBody.constraint.category === OptionValidationErrorStatus.OPTION_DNE) return ({
            userMessage: `❌ The ${oBody.field} **${oBody.value}** was not found.`, ephemeral: true,
        });
        else if (oBody.constraint.category === OptionValidationErrorStatus.OPTION_UNDEFAULTABLE) return ({
            userMessage: `❌ There is no current tournament. You must either specify a tournament by name or activate a tournament, then try again.`, ephemeral: true,
        });
        else if (oBody.constraint.category === OptionValidationErrorStatus.OPTION_DUPLICATE) return ({
            userMessage: `❌ A challenge named **${oBody.value}** already exists in the tournament.`, ephemeral: true,
        });
        else if (oBody.constraint.category === OptionValidationErrorStatus.OPTION_TOO_LONG) {
            let characterLimit = -1;
            if (oBody.field === 'name') characterLimit = config.fieldCharacterLimits.challengeName;
            else if (oBody.field === 'game') characterLimit = config.fieldCharacterLimits.game;
            else if (oBody.field === 'description') characterLimit = config.fieldCharacterLimits.challengeDescription;
            return {
                userMessage: `❌ The ${oBody.field} must be ${characterLimit} characters or less. Please shorten it by ${oBody.value.length - characterLimit}.`, ephemeral: true,
            };
        } else return ({
            userMessage: `❌ This command failed due to a validation error.`, ephemeral: true,
        });
    }],
]);

const CreateChallengeCommand = new SimpleRendezvousSlashCommand<CreateChallengeOutcome, CreateChallengeSolverParams, T1, CreateChallengeStatus>(
    new SlashCommandBuilder()
        .setName('create-challenge')
        .setDescription('Create a challenge.')
        .addStringOption(option => option.setName('name').setDescription(`A short name for the challenge.`).setRequired(true))
        .addStringOption(option => option.setName('game').setDescription('The name of the game, or something else like "IRL".').setRequired(true))
        .addStringOption(option => option.setName('description').setDescription('The complete description of the challenge, restrictions, and rules.').setRequired(true))
        .addStringOption(option => option.setName('tournament').setDescription('The tournament the challenge is part of. Defaults to current tournament.').setRequired(false))
        .addStringOption(option => option.setName('difficulty').setDescription('The emoji representing the challenge level. Defaults to default difficulty.').setRequired(false))
        .addBooleanOption(option => option.setName('visible').setDescription('Whether the challenge is visible to contestants. Defaults true.').setRequired(false)) as SlashCommandBuilder,
    createChallengeSlashCommandDescriptions,
    createChallengeSlashCommandValidator,
    createChallengeSolver,
);

export default CreateChallengeCommand;