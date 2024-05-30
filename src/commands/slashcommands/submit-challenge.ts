import { SlashCommandBuilder } from '@discordjs/builders';
import { getTournamentByName } from '../../backend/queries/tournamentQueries.js';
import { SubmissionDocument } from '../../types/customDocument.js';
import { getCurrentTournament } from '../../backend/queries/guildSettingsQueries.js';
import { getChallengeOfTournamentByName } from '../../backend/queries/challengeQueries.js';
import { getOrCreateContestant } from '../../backend/queries/profileQueries.js';
import { createSubmission, getSubmissionsForChallengeFromContestant } from '../../backend/queries/submissionQueries.js';
import { SubmissionStatus } from '../../backend/schemas/submission.js';
import { ValueOf } from '../../types/typelogic.js';
import config from '../../config.js';
import { OutcomeStatus, Outcome, LimitedCommandInteraction, OptionValidationErrorOutcome, Constraint, LimitedCommandInteractionOption, OptionValidationErrorStatus, validateConstraints, OptionValidationError, SlashCommandDescribedOutcome, OutcomeWithMonoBody, OutcomeWithDuoBody, SimpleRendezvousSlashCommand } from 'discord-rendezvous';

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
enum SubmitChallengeSpecificStatus {
    FAIL_TOURNAMENT_INACTIVE = 'FAIL_TOURNAMENT_INACTIVE',
    FAIL_TOURNAMENT_HIDDEN = 'FAIL_TOURNAMENT_HIDDEN',
    FAIL_CHALLENGE_HIDDEN = 'FAIL_CHALLENGE_HIDDEN',
    FAIL_EXISTING_SUBMISSION = 'FAIL_EXISTING_SUBMISSION',
}

/**
 * Union of specific and generic status codes.
 */
type SubmitChallengeStatus = SubmitChallengeSpecificStatus | OutcomeStatus;

/**
 * The outcome format for the specific status code(s).
 * Since all can reuse the same body format, they are all combined into one type, to later be
 * discriminated by the status code.
 */
type SubmitChallengeSpecificOutcome = {
    status: SubmitChallengeSpecificStatus.FAIL_TOURNAMENT_INACTIVE | SubmitChallengeSpecificStatus.FAIL_TOURNAMENT_HIDDEN | SubmitChallengeSpecificStatus.FAIL_CHALLENGE_HIDDEN | SubmitChallengeSpecificStatus.FAIL_EXISTING_SUBMISSION;
    body: {
        data: string;
    };
};

/**
 * Union of specific and generic outcomes.
 */
type SubmitChallengeOutcome = Outcome<T1, T2, SubmitChallengeSpecificOutcome>;

interface SubmitChallengeSolverParams {
    guildId: string;
    challengeName: string;
    contestantId: string;
    proofLink: string;
    tournamentName?: string;
}

const submitChallengeSolver = async (params: SubmitChallengeSolverParams): Promise<SubmitChallengeOutcome> => {
    try {
        // Ensure the Tournament and Challenge exist
        const tournament = params.tournamentName ? await getTournamentByName(params.guildId, params.tournamentName) : await getCurrentTournament(params.guildId);
        if (!tournament) return ({
            status: OutcomeStatus.FAIL_DNE_MONO,
            body: {
                data: params.tournamentName ? params.tournamentName : '(currentTournament)',
                context: 'tournament',
            }
        });
        if (!tournament.active) return ({
            status: SubmitChallengeSpecificStatus.FAIL_TOURNAMENT_INACTIVE,
            body: {
                data: tournament.name,
            }
        });
        if (!tournament.visibility) return ({
            status: SubmitChallengeSpecificStatus.FAIL_TOURNAMENT_HIDDEN,
            body: {
                data: tournament ? tournament.name : '(currentTournament)',
            }
        });
        const challenge = await getChallengeOfTournamentByName(params.challengeName, tournament);
        if (!challenge) return ({
            status: OutcomeStatus.FAIL_DNE_DUO,
            body: {
                data1: params.challengeName,
                context1: 'challenge',
                data2: tournament.name,
                context2: 'tournament',
            },
        });
        if (!challenge.visibility) return ({
            status: SubmitChallengeSpecificStatus.FAIL_CHALLENGE_HIDDEN,
            body: {
                data: challenge.name,
            }
        });
        const contestant = await getOrCreateContestant(params.guildId, params.contestantId);

        // Fail if contestant already has pending or accepted submission for this challenge
        const submissions = await getSubmissionsForChallengeFromContestant(challenge, contestant);
        if (submissions) {
            // Using for ... of syntax since filter does not support async functions
            // (Promise<false> is truthy because any Promise is truthy)
            const nonRejectedSubmissions = new Array<SubmissionDocument>();
            for (const submission of submissions) {
                if (await submission.get('status') !== SubmissionStatus.REJECTED) {
                    nonRejectedSubmissions.push(submission);
                }
            }
            if (nonRejectedSubmissions.length > 0) return ({
                status: SubmitChallengeSpecificStatus.FAIL_EXISTING_SUBMISSION,
                body: {
                    data: challenge.name,
                },
            });
        }

        // Create the submission
        await createSubmission(challenge, contestant, params.proofLink);

        return ({
            status: OutcomeStatus.SUCCESS_MONO,
            body: {
                data: challenge.name,
                context: 'challenge',
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

const submitChallengeSlashCommandValidator = async (interaction: LimitedCommandInteraction): Promise<SubmitChallengeSolverParams | OptionValidationErrorOutcome<T1>> => {
    const guildId = interaction.guildId!;

    const metadataConstraints = new Map<keyof LimitedCommandInteraction, Constraint<ValueOf<LimitedCommandInteraction>>[]>([]);

    const proofLink = interaction.options.get('proof-link', true);
    const tournament = interaction.options.get('tournament', false);
    const optionConstraints = new Map<LimitedCommandInteractionOption | null, Constraint<ValueOf<LimitedCommandInteractionOption>>[]>([
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
        [proofLink, [
            // Ensure that the proof link's length is <= 200 characters
            {
                category: OptionValidationErrorStatus.OPTION_TOO_LONG,
                func: async function(option: ValueOf<LimitedCommandInteractionOption>): Promise<boolean> {
                    return (option as string).length <= config.fieldCharacterLimits.proofLink;
                }
            }
        ]],
    ]);

    let challengeName: string;
    try {
        challengeName = interaction.options.get('name', true).value! as string;
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
        challengeName: challengeName,
        contestantId: interaction.member!.user!.id,
        proofLink: proofLink.value! as string,
        tournamentName: (tournament ? tournament.value as string : undefined),
    };
};

const submitChallengeSlashCommandDescriptions = new Map<SubmitChallengeStatus, (o: SubmitChallengeOutcome) => SlashCommandDescribedOutcome>([
    [OutcomeStatus.SUCCESS_MONO, (o: SubmitChallengeOutcome) => ({
        userMessage: `✅ Submission for **${(o as OutcomeWithMonoBody<T1>).body.data}** sent for review!`, ephemeral: true,
    })],
    [SubmitChallengeSpecificStatus.FAIL_TOURNAMENT_HIDDEN, (o: SubmitChallengeOutcome) => {
        if ((o as SubmitChallengeSpecificOutcome).body.data === '(currentTournament)') return ({
            userMessage: `❌ The current tournament is currently hidden and is not accepting submissions.`, ephemeral: true,
        });
        else return ({
            userMessage: `❌ That tournament is currently hidden and is not accepting submissions.`, ephemeral: true,
        });
    }],
    [SubmitChallengeSpecificStatus.FAIL_TOURNAMENT_INACTIVE, (o: SubmitChallengeOutcome) => ({
        userMessage: `❌ The tournament **${(o as SubmitChallengeSpecificOutcome).body.data}** is not accepting submissions.`, ephemeral: true,
    })],
    [SubmitChallengeSpecificStatus.FAIL_CHALLENGE_HIDDEN, (_: SubmitChallengeOutcome) => ({
        userMessage: `❌ That challenge is currently hidden and is not accepting submissions.`, ephemeral: true,
    })],
    [SubmitChallengeSpecificStatus.FAIL_EXISTING_SUBMISSION, (o: SubmitChallengeOutcome) => ({
        userMessage: `❌ Your previous submission to **${(o as SubmitChallengeSpecificOutcome).body.data}** is either waiting to be approved or was already approved.`, ephemeral: true,
    })],
    [OutcomeStatus.FAIL_DNE_MONO, (o: SubmitChallengeOutcome) => {
        const oBody = (o as OutcomeWithMonoBody<T1>).body;
        if (oBody.context === 'tournament') return (
            oBody.data === '(currentTournament)' ? ({
                userMessage: `❌ The current tournament was not found.`, ephemeral: true
            }) : ({
                userMessage: `❌ The tournament **${oBody.data}** was not found.`, ephemeral: true
            })
        );
        else return ({
            userMessage: `❌ This command failed unexpectedly. **${oBody.data}** does not exist.`, ephemeral: true
        });
    }],
    [OutcomeStatus.FAIL_DNE_DUO, (o: SubmitChallengeOutcome) => {
        const oBody = (o as OutcomeWithDuoBody<T1>).body;
        if (oBody.context1 === 'challenge' && oBody.context2 === 'tournament') return ({
            userMessage: `❌ The challenge **${oBody.data1}** was not found in the tournament **${oBody.data2}**.`, ephemeral: true
        });
        else return ({
            userMessage: `❌ This command failed unexpectedly.`, ephemeral: true
        });
    }],
    [OutcomeStatus.FAIL_VALIDATION, (o: SubmitChallengeOutcome) => {
        const oBody = (o as OptionValidationErrorOutcome<T1>).body;
        if (oBody.constraint.category === OptionValidationErrorStatus.OPTION_DNE) return ({
            userMessage: `❌ The tournament **${oBody.value}** was not found.`, ephemeral: true
        });
        else return ({
            userMessage: `❌ This command failed unexpectedly due to a validation error.`, ephemeral: true
        });
    }],
]);

const SubmitChallengeCommand = new SimpleRendezvousSlashCommand<SubmitChallengeOutcome, SubmitChallengeSolverParams, T1, SubmitChallengeStatus>(
    new SlashCommandBuilder()
        .setName('submit-challenge')
        .setDescription('Send your submission for a challenge you completed, along with proof.')
        .addStringOption(option => option.setName('name').setDescription('The name of the challenge.').setRequired(true))
        .addStringOption(option => option.setName('proof-link').setDescription('Your proof of completing the challenge. Linkless? Send it on this server then Copy Message Link!').setRequired(true))
        .addStringOption(option => option.setName('tournament').setDescription('The tournament the challenge is part of. Defaults to current tournament.').setRequired(false)) as SlashCommandBuilder,
    submitChallengeSlashCommandDescriptions,
    submitChallengeSlashCommandValidator,
    submitChallengeSolver,
);

export default SubmitChallengeCommand;