import { SlashCommandBuilder } from '@discordjs/builders';
import { GuildMember, PermissionsBitField } from 'discord.js';
import { getTournamentByName, updateTournament } from '../../backend/queries/tournamentQueries.js';
import { ResolvedTournament, resolveTournaments } from '../../types/customDocument.js';
import { ValueOf } from '../../types/typelogic.js';
import { formatTournamentDetails } from './tournaments.js';
import { getJudgeByGuildIdAndMemberId } from '../../backend/queries/profileQueries.js';
import config from '../../config.js';
import { OutcomeStatus, Outcome, LimitedCommandInteraction, OptionValidationErrorOutcome, Constraint, OptionValidationErrorStatus, LimitedCommandInteractionOption, validateConstraints, OptionValidationError, SlashCommandDescribedOutcome, OutcomeWithMonoBody, SimpleRendezvousSlashCommand } from 'discord-rendezvous';

/**
 * Alias for the first generic type of the command.
 */
type T1 = ResolvedTournament[];

/**
 * Alias for the second generic type of the command.
 */
type T2 = void;

/**
 * Status codes specific to this command.
 */
enum _EditTournamentSpecificStatus {

}

/**
 * Union of specific and generic status codes.
 */
type EditTournamentStatus = OutcomeStatus;


/**
 * Union of specific and generic outcomes.
 */
type EditTournamentOutcome = Outcome<T1, T2>;

/**
 * Parameters for the solver function, as well as the "S" generic type.
 */
interface EditTournamentSolverParams {
    guildId: string;
    name: string;
    newName?: string | undefined;
    photoURI?: string | undefined;
    visible?: boolean | undefined;
    active?: boolean | undefined;
    statusDescription?: string | undefined;
    duration?: string | undefined;
}

/**
 * Performs the entire editing process on a Tournament.
 * @param params The parameters object for the solver function.
 * @returns A EditTournamentOutcome, in all cases.
 */
const editTournamentSolver = async (params: EditTournamentSolverParams): Promise<EditTournamentOutcome> => {
    try {
        const tournament = await getTournamentByName(params.guildId, params.name);

        const tournamentUpdate = await updateTournament(
            tournament!._id, 
            // Conditionally add properties to the object. It would be almost equivalent to assign some but with the value undefined
            {
                ...(params.newName && { name: params.newName }),
                ...(params.photoURI && { photoURI: params.photoURI }),
                ...(params.active !== null && { active: params.active }),
                ...(params.visible !== null && { visibility: params.visible }),
                ...(params.statusDescription && { statusDescription: params.statusDescription }),
                ...(params.duration && { duration: params.duration }),
            }
        );

        if (!tournamentUpdate) return {
            status: OutcomeStatus.FAIL_UNKNOWN,
            body: {},
        };

        return {
            status: OutcomeStatus.SUCCESS_MONO,
            body: {
                data: await resolveTournaments([tournamentUpdate]),
                context: `tournament`,
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

const editTournamentSlashCommandValidator = async (interaction: LimitedCommandInteraction): Promise<EditTournamentSolverParams | OptionValidationErrorOutcome<T1>> => {
    const guildId = interaction.guildId!;
    const name = interaction.options.get('name', true);
    const newName = interaction.options.get('new-name', false);

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
        [name, [
            // Ensure that the tournament exists
            {
                category: OptionValidationErrorStatus.OPTION_DNE,
                func: async function(option: ValueOf<LimitedCommandInteractionOption>): Promise<boolean> {
                    const tournamentDocument = await getTournamentByName(guildId, option as string);
                    return tournamentDocument !== null;
                }
            }
        ]],
        [newName, [
            // Ensure tournament name is <= 45 characters
            {
                category: OptionValidationErrorStatus.OPTION_TOO_LONG,
                func: async function(option: ValueOf<LimitedCommandInteractionOption>): Promise<boolean> {
                    return (option as string).length <= config.fieldCharacterLimits.tournamentName;
                },
            },
            // Ensure that no other Tournament exists with the same name
            {
                category: OptionValidationErrorStatus.OPTION_DUPLICATE,
                func: async function(option: ValueOf<LimitedCommandInteractionOption>): Promise<boolean> {
                    const tournamentDocument = await getTournamentByName(guildId, option as string);
                    return tournamentDocument === null;
                },
            },
        ]],
    ]);

    
    const photoURI = interaction.options.get('photo-uri', false)?.value as string ?? undefined;
    const visible = interaction.options.get('visible', false)?.value !== undefined ? interaction.options.get('visible', false)?.value as boolean : undefined;
    const active = interaction.options.get('active', false)?.value !== undefined ? interaction.options.get('active', false)?.value as boolean : undefined;
    const statusDescription = interaction.options.get('status-description', false)?.value as string ?? undefined;
    const duration = interaction.options.get('duration', false)?.value as string ?? undefined;

    const newNameString = newName?.value as string ?? undefined;
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
            }
        };

        throw err;
    }

    return {
        guildId,
        name: name.value as string,
        newName: newNameString,
        photoURI,
        visible,
        active,
        statusDescription,
        duration,
    };
};

const editTournamentSlashCommandDescriptions = new Map<EditTournamentStatus, (o: EditTournamentOutcome) => SlashCommandDescribedOutcome>([
    [OutcomeStatus.SUCCESS_MONO, (o: EditTournamentOutcome) => ({
        userMessage: `✅ Tournament updated!\n` + formatTournamentDetails((o as OutcomeWithMonoBody<T1>).body.data[0]), ephemeral: true
    })],
    [OutcomeStatus.FAIL_VALIDATION, (o: EditTournamentOutcome) => {
        const oBody = (o as OptionValidationErrorOutcome<T1>).body;
        if (oBody.constraint.category === OptionValidationErrorStatus.OPTION_DNE) return {
            userMessage: `❌ That tournament, **${oBody.value}**, was not found.`, ephemeral: true
        };
        if (oBody.constraint.category === OptionValidationErrorStatus.INSUFFICIENT_PERMISSIONS) return {
            userMessage: `❌ You do not have permission to edit tournaments.`, ephemeral: true
        };
        if (oBody.constraint.category === OptionValidationErrorStatus.OPTION_DUPLICATE) return {
            userMessage: `❌ A tournament with the name **${oBody.value}** already exists.`, ephemeral: true
        };
        else if (oBody.constraint.category === OptionValidationErrorStatus.OPTION_TOO_LONG) {
            let characterLimit = -1;
            if (oBody.field === 'new-name') characterLimit = config.fieldCharacterLimits.tournamentName;
            return {
                userMessage: `❌ The ${oBody.field} must be ${characterLimit} characters or less.`, ephemeral: true,
            };
        } else return {
            userMessage: `❌ This command failed unexpectedly due to a validation error.`, ephemeral: true
        };
    }],
]);

const EditTournamentCommand = new SimpleRendezvousSlashCommand<EditTournamentOutcome, EditTournamentSolverParams, T1, EditTournamentStatus>(
    new SlashCommandBuilder()
        .setName('edit-tournament')
        .setDescription('Edit the details of a Tournament.')
        .addStringOption(option => option.setName('name').setDescription('The name of the tournament.').setRequired(true))
        .addStringOption(option => option.setName('new-name').setDescription('Rename the tournament to this.').setRequired(false))
        .addStringOption(option => option.setName('photo-uri').setDescription(`Change the linked image for the tournament's thumbnail.`).setRequired(false))
        .addBooleanOption(option => option.setName('visible').setDescription('Change whether the tournament can be seen by non-judges.').setRequired(false))
        .addBooleanOption(option => option.setName('active').setDescription('Change whether the tournament is accepting submissions now.').setRequired(false))
        .addStringOption(option => option.setName('status-description').setDescription('Change the explanation message for the tournament\'s current status.').setRequired(false))
        .addStringOption(option => option.setName('duration').setDescription('Change the message for when the tournament takes place.').setRequired(false)) as SlashCommandBuilder,
    editTournamentSlashCommandDescriptions,
    editTournamentSlashCommandValidator,
    editTournamentSolver,
);

export default EditTournamentCommand;