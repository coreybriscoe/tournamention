import { SlashCommandBuilder } from 'discord.js';
import { ValueOf } from '../../types/typelogic.js';
import { getTournamentByName } from '../../backend/queries/tournamentQueries.js';
import { getCurrentTournament } from '../../backend/queries/guildSettingsQueries.js';
import { PendingSubmissionsOutcome, PendingSubmissionsSolverParams, PendingSubmissionsStatus, T1, pendingSubmissionsSlashCommandDescriptions, pendingSubmissionsSolver } from './pending-submissions/pending-submissions-exports.js';
import { LimitedCommandInteraction, OptionValidationErrorOutcome, Constraint, LimitedCommandInteractionOption, ALWAYS_OPTION_CONSTRAINT, OptionValidationErrorStatus, validateConstraints, OptionValidationError, OutcomeStatus, SimpleRendezvousSlashCommand } from 'discord-rendezvous';


const pendingSubmissionsSlashCommandValidator = async (interaction: LimitedCommandInteraction): Promise<PendingSubmissionsSolverParams | OptionValidationErrorOutcome<T1>> => {
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
        guildId,
        tournament: tournament?.value as string | undefined,
        page: 0,
    };
};

const PendingSubmissionsCommand = new SimpleRendezvousSlashCommand<PendingSubmissionsOutcome, PendingSubmissionsSolverParams, T1, PendingSubmissionsStatus>(
    new SlashCommandBuilder()
        .setName('pending-submissions')
        .setDescription('Show the submissions waiting for review in the tournament.')
        .addStringOption(option => option.setName('tournament').setDescription('The tournament to view. Defaults to current tournament.').setRequired(false)) as SlashCommandBuilder,
    pendingSubmissionsSlashCommandDescriptions,
    pendingSubmissionsSlashCommandValidator,
    pendingSubmissionsSolver,
    false,
    true,
);

export default PendingSubmissionsCommand;