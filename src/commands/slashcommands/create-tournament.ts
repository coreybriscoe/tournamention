import { SlashCommandBuilder } from '@discordjs/builders';
import { GuildMember, PermissionsBitField } from 'discord.js';
import { TournamentBuilder, getTournamentByName } from '../../backend/queries/tournamentQueries.js';
import { ResolvedTournament, resolveTournaments } from '../../types/customDocument.js';
import { getJudgeByGuildIdAndMemberId } from '../../backend/queries/profileQueries.js';
import { ValueOf } from '../../types/typelogic.js';
import { formatTournamentDetails } from './tournaments.js';
import config from '../../config.js';
import { OutcomeStatus, Outcome, LimitedCommandInteraction, OptionValidationErrorOutcome, Constraint, OptionValidationErrorStatus, LimitedCommandInteractionOption, validateConstraints, OptionValidationError, SlashCommandDescribedOutcome, OutcomeWithMonoBody, SimpleRendezvousSlashCommand } from 'discord-rendezvous';

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
enum _CreateTournamentSpecificStatus {

}

/**
 * Union of specific and generic status codes.
 */
type CreateTournamentStatus = OutcomeStatus;


/**
 * Union of specific and generic outcomes.
 */
type CreateTournamentOutcome = Outcome<T1, T2>;

/**
 * Parameters for the solver function, as well as the "S" generic type.
 */
interface CreateTournamentSolverParams {
    guildId: string;
    name: string;
    photoURI?: string | undefined;
    visible?: boolean | undefined;
    active?: boolean | undefined;
    statusDescription?: string | undefined;
    duration?: string | undefined;
}

/**
 * Creates a tournament with the given parameters.
 * @param params The parameters object for the solver function.
 * @returns A `CreateTournamentOutcome`, in all cases.
 */
const createTournamentSolver = async (params: CreateTournamentSolverParams): Promise<CreateTournamentOutcome> => {
    try {
        const photoURI = params.photoURI !== undefined ? params.photoURI : '';
        const visibility = params.visible !== undefined ? params.visible : true;
        const active = params.active !== undefined ? params.active : true;
        const statusDescription = params.statusDescription !== undefined ? params.statusDescription : '';
        const duration = params.duration !== undefined ? params.duration : '';
        const tournamentBuilder = new TournamentBuilder()
            .setName(params.name)
            .setPhotoURI(photoURI)
            .setVisibility(visibility)
            .setActive(active)
            .setStatusDescription(statusDescription)
            .setDuration(duration);
        const tournament = await tournamentBuilder.buildForGuild(params.guildId);
        if (!tournament) return {
            status: OutcomeStatus.FAIL_UNKNOWN,
            body: {},
        };

        return {
            status: OutcomeStatus.SUCCESS_MONO,
            body: {
                data: (await resolveTournaments([tournament]))[0],
                context: '',
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

const createTournamentSlashCommandValidator = async (interaction: LimitedCommandInteraction): Promise<CreateTournamentSolverParams | OptionValidationErrorOutcome<T1>> => {
    const guildId = interaction.guildId!;
    const name = interaction.options.get('name', true);

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
    const visible = interaction.options.get('visible', false)?.value as boolean;
    const active = interaction.options.get('active', false)?.value as boolean;
    const statusDescription = interaction.options.get('status-description', false)?.value as string ?? undefined;
    const duration = interaction.options.get('duration', false)?.value as string ?? undefined;

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
        photoURI,
        visible,
        active,
        statusDescription,
        duration,
    };
};

const createTournamentSlashCommandDescriptions = new Map<CreateTournamentStatus, (o: CreateTournamentOutcome) => SlashCommandDescribedOutcome>([
    [OutcomeStatus.SUCCESS_MONO, (o: CreateTournamentOutcome) => ({
        userMessage: `✅ Tournament created!\n${formatTournamentDetails((o as OutcomeWithMonoBody<T1>).body.data)}`, ephemeral: true
    })],
    [OutcomeStatus.FAIL_VALIDATION, (o: CreateTournamentOutcome) => {
        const oBody = (o as OptionValidationErrorOutcome<T1>).body;
        if (oBody.constraint.category === OptionValidationErrorStatus.INSUFFICIENT_PERMISSIONS) return {
            userMessage: `❌ You do not have permission to create a tournament.`, ephemeral: true
        };
        else if (oBody.constraint.category === OptionValidationErrorStatus.OPTION_DUPLICATE) return {
            userMessage: `❌ A tournament with the name **${oBody.value}** already exists.`, ephemeral: true
        };
        else if (oBody.constraint.category === OptionValidationErrorStatus.OPTION_TOO_LONG) {
            let characterLimit = -1;
            if (oBody.field === 'name') characterLimit = config.fieldCharacterLimits.tournamentName;
            return {
                userMessage: `❌ The ${oBody.field} must be ${characterLimit} characters or less.`, ephemeral: true,
            };
        } else return {
            userMessage: `❌ This command failed unexpectedly due to a validation error.`, ephemeral: true
        };
    }],
]);

const CreateTournamentCommand = new SimpleRendezvousSlashCommand<CreateTournamentOutcome, CreateTournamentSolverParams, T1, CreateTournamentStatus>(
    new SlashCommandBuilder()
        .setName('create-tournament')
        .setDescription('Create a new tournament from scratch.')
        .addStringOption(option => option.setName('name').setDescription('The name of the tournament').setRequired(true))
        .addStringOption(option => option.setName('photo-uri').setDescription(`A linked image for the tournament's thumbnail.`).setRequired(false))
        .addBooleanOption(option => option.setName('visible').setDescription('Whether the tournament can be seen by non-judges. Defaults true.').setRequired(false))
        .addBooleanOption(option => option.setName('active').setDescription('Whether the tournament is accepting submissions now. Defaults true.').setRequired(false))
        .addStringOption(option => option.setName('status-description').setDescription('An explanation of the tournament\'s current status.').setRequired(false))
        .addStringOption(option => option.setName('duration').setDescription('A simple description of when the tournament takes place.').setRequired(false)) as SlashCommandBuilder,
    createTournamentSlashCommandDescriptions,
    createTournamentSlashCommandValidator,
    createTournamentSolver,
);

export default CreateTournamentCommand;