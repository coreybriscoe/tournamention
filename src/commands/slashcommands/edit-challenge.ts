import { SlashCommandBuilder } from '@discordjs/builders';
import { GuildMember, PermissionsBitField } from 'discord.js';
import { getDifficultyByEmoji, getTournamentByName } from '../../backend/queries/tournamentQueries.js';
import { DifficultyDocument } from '../../types/customDocument.js';
import { getCurrentTournament } from '../../backend/queries/guildSettingsQueries.js';
import { getChallengeOfTournamentByName, updateChallengeById } from '../../backend/queries/challengeQueries.js';
import { ValueOf } from '../../types/typelogic.js';
import { getJudgeByGuildIdAndMemberId } from '../../backend/queries/profileQueries.js';
import config from '../../config.js';
import { OutcomeStatus, Outcome, LimitedCommandInteraction, OptionValidationErrorOutcome, Constraint, OptionValidationErrorStatus, LimitedCommandInteractionOption, validateConstraints, OptionValidationError, SlashCommandDescribedOutcome, OutcomeWithMonoBody, OutcomeWithDuoBody, SimpleRendezvousSlashCommand } from 'discord-rendezvous';

/**
 * Alias for the first generic type of the command.
 */
type T1 = string;

/**
 * Alias for the second generic type of the command.
 */
type T2 = string;

/**
 * Status codes specific to this command.
 */
enum _EditChallengeSpecificStatus {

}

/**
 * Union of specific and generic status codes.
 */
type EditChallengeStatus = OutcomeStatus;

/**
 * Union of specific and generic outcomes.
 */
type EditChallengeOutcome = Outcome<T1, T2>;

/**
 * Parameters for the solver function, as well as the "S" generic type.
 */
interface EditChallengeSolverParams {
    guildId: string;
    name: string;
    tournamentName?: string | undefined;
    newName?: string | undefined;
    description?: string | undefined;
    difficulty?: string | undefined;
    game?: string | undefined;
    visible?: boolean | undefined;
}

/**
 * Performs the entire editing process on a Challenge.
 * @param params The parameters object for the solver function.
 * @returns An EditChallengeOutcome, in all cases.
 */
const editChallengeSolver = async (params: EditChallengeSolverParams): Promise<EditChallengeOutcome> => {
    try {
        const tournament = params.tournamentName ? await getTournamentByName(params.guildId, params.tournamentName) : await getCurrentTournament(params.guildId);
        if (!tournament) return {
            status: OutcomeStatus.FAIL_DNE_MONO,
            body: {
                data: params.tournamentName ?? 'current tournament',
                context: 'tournament',
            },
        };
        let difficultyDocument: DifficultyDocument | null = null;
        if (params.difficulty) {
            difficultyDocument = await getDifficultyByEmoji(tournament, params.difficulty);
        }
        const challenge = await getChallengeOfTournamentByName(params.name, tournament!);
        if (!challenge) return {
            status: OutcomeStatus.FAIL_DNE_DUO,
            body: {
                data1: params.name,
                context1: 'challenge',
                data2: tournament.name,
                context2: 'tournament',
            },
        };

        const challengeUpdate = await updateChallengeById(
            challenge._id,
            {
                ...(params.newName && { name: params.newName }),
                ...(params.description && { description: params.description }),
                ...((params.difficulty && difficultyDocument) && { difficulty: difficultyDocument._id }),
                ...(params.game && { game: params.game }),
                ...(params.visible !== null && { visibility: params.visible }),
            }
        );
        if (!challengeUpdate) return {
            status: OutcomeStatus.FAIL_UNKNOWN,
            body: {},
        };

        if (params.newName) return {
            status: OutcomeStatus.SUCCESS_DUO,
            body: {
                data1: params.name,
                context1: 'old challenge name',
                data2: params.newName,
                context2: 'new challenge name',
            },
        };
        return {
            status: OutcomeStatus.SUCCESS_MONO,
            body: {
                data: params.name,
                context: 'challenge',
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

const editChallengeSlashCommandValidator = async (interaction: LimitedCommandInteraction): Promise<EditChallengeSolverParams | OptionValidationErrorOutcome<T1>> => {
    const guildId = interaction.guildId!;
    const name = interaction.options.get('name', true);
    const tournament = interaction.options.get('tournament', false);
    const difficulty = interaction.options.get('difficulty', false);
    const newName = interaction.options.get('new-name', false);
    const game = interaction.options.get('game', false);
    const description = interaction.options.get('description', false);

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
        [name, [
            // Ensure that either the specified Tournament exists or there is a current Tournament
            // This constraint hijacks the required option name and does not use its value
            {
                category: OptionValidationErrorStatus.OPTION_UNDEFAULTABLE,
                func: async function(_: ValueOf<LimitedCommandInteractionOption>): Promise<boolean> {
                    const tournamentDocument = tournament ? await getTournamentByName(guildId, tournament.value as string) : await getCurrentTournament(guildId);
                    return tournamentDocument !== null;
                },
            },
            // Ensure that the challenge exists
            {
                category: OptionValidationErrorStatus.OPTION_DNE,
                func: async function(option: ValueOf<LimitedCommandInteractionOption>): Promise<boolean> {
                    const tournamentDocument = tournament ? await getTournamentByName(guildId, tournament.value as string) : await getCurrentTournament(guildId);
                    if (!tournamentDocument) return false;
                    const challengeDocument = await getChallengeOfTournamentByName(option as string, tournamentDocument);
                    return challengeDocument !== null;
                }
            }
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
        [newName, [
            // Ensure challenge name is <= 40 characters
            {
                category: OptionValidationErrorStatus.OPTION_TOO_LONG,
                func: async function(option: ValueOf<LimitedCommandInteractionOption>): Promise<boolean> {
                    return (option as string).length <= config.fieldCharacterLimits.challengeName;
                },
            },
            // Ensure that no challenge exists already with the new name in the tournament
            {
                category: OptionValidationErrorStatus.OPTION_DUPLICATE,
                func: async function(option: ValueOf<LimitedCommandInteractionOption>): Promise<boolean> {
                    const tournamentDocument = tournament ? await getTournamentByName(guildId, tournament.value as string) : await getCurrentTournament(guildId);
                    if (!tournamentDocument) return false;
                    const challengeDocument = await getChallengeOfTournamentByName(option as string, tournamentDocument);
                    return challengeDocument === null;
                }
            },
        ]],
    ]);

    const visible = interaction.options.get('visible', false)?.value as boolean;
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
        name: name.value as string,
        newName: newName ? newName.value as string : undefined,
        game: game ? game.value as string : undefined,
        description: description ? description.value as string : undefined,
        visible: visible,
        tournamentName: tournament ? tournament.value as string : undefined,
        difficulty: difficulty ? difficulty.value as string : undefined,
    };
};

const editChallengeSlashCommandDescriptions = new Map<EditChallengeStatus, (o: EditChallengeOutcome) => SlashCommandDescribedOutcome>([
    [OutcomeStatus.SUCCESS_MONO, (o: EditChallengeOutcome) => ({
        userMessage: `✅ Challenge **${(o as OutcomeWithMonoBody<T1>).body.data}** updated!`, ephemeral: true,
    })],
    [OutcomeStatus.SUCCESS_DUO, (o: EditChallengeOutcome) => ({
        userMessage: `✅ Challenge **${(o as OutcomeWithDuoBody<T1>).body.data2}** (formerly known as **${(o as OutcomeWithDuoBody<T1>).body.data1}**) updated!`, ephemeral: true,
    })],
    [OutcomeStatus.FAIL_VALIDATION, (o: EditChallengeOutcome) => {
        const oBody = (o as OptionValidationErrorOutcome<T1>).body;
        if (oBody.constraint.category === OptionValidationErrorStatus.INSUFFICIENT_PERMISSIONS) return ({
            userMessage: `❌ You do not have permission to use this command.`, ephemeral: true,
        });
        else if (oBody.constraint.category === OptionValidationErrorStatus.OPTION_DNE) {
            if (oBody.field === 'name') return {
                userMessage: `❌ The challenge **${oBody.value}** was not found.`, ephemeral: true,
            };
            else return {
                userMessage: `❌ The ${oBody.field} **${oBody.value}** was not found.`, ephemeral: true,
            };
        } else if (oBody.constraint.category === OptionValidationErrorStatus.OPTION_UNDEFAULTABLE) return ({
            userMessage: `❌ There is no current tournament. You must either specify a tournament by name or activate a tournament, then try again.`, ephemeral: true,
        });
        else if (oBody.constraint.category === OptionValidationErrorStatus.OPTION_DUPLICATE) return ({
            userMessage: `❌ A challenge named **${oBody.value}** already exists in the tournament.`, ephemeral: true,
        });
        else if (oBody.constraint.category === OptionValidationErrorStatus.OPTION_TOO_LONG) {
            let characterLimit = -1;
            if (oBody.field === 'new-name') characterLimit = config.fieldCharacterLimits.challengeName;
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

const EditChallengeCommand = new SimpleRendezvousSlashCommand<EditChallengeOutcome, EditChallengeSolverParams, T1, EditChallengeStatus>(
    new SlashCommandBuilder()
        .setName('edit-challenge')
        .setDescription('Edit the details of a Challenge.')
        .addStringOption(option => option.setName('name').setDescription('The name of the challenge.').setRequired(true))
        .addStringOption(option => option.setName('tournament').setDescription('The tournament the challenge is in. Defaults to current tournament.').setRequired(false))
        .addStringOption(option => option.setName('new-name').setDescription('Rename the challenge to this.').setRequired(false))
        .addStringOption(option => option.setName('description').setDescription('Change the description of the challenge, including restrictions or rules.').setRequired(false))
        .addStringOption(option => option.setName('difficulty').setDescription(`Change the challenge's difficulty, using the emoji of a difficulty that exists in the tournament.`).setRequired(false))
        .addStringOption(option => option.setName('game').setDescription('Change the game this challenge is for, or something else like "IRL".').setRequired(false))
        .addBooleanOption(option => option.setName('visible').setDescription('Change whether the tournament can be seen by non-judges.').setRequired(false)) as SlashCommandBuilder,
    editChallengeSlashCommandDescriptions,
    editChallengeSlashCommandValidator,
    editChallengeSolver,
);

export default EditChallengeCommand;