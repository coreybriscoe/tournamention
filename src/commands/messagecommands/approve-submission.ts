import { ApplicationCommandType, CommandInteraction, ContextMenuCommandBuilder, GuildMember, Message, PermissionsBitField } from 'discord.js';
import { getCurrentTournament } from '../../backend/queries/guildSettingsQueries.js';
import { getSubmissionInCurrentTournamentFromContestantWithLink } from '../../backend/queries/submissionQueries.js';
import { getContestantByGuildIdAndMemberId, getJudgeByGuildIdAndMemberId } from '../../backend/queries/profileQueries.js';
import { MakeReviewNoteAndInterpretResultOutcomeStatus, makeReviewNoteAndInterpretResult } from '../slashcommands/judge-submission.js';
import { getChallengeById } from '../../backend/queries/challengeQueries.js';
import { ResolvedChallenge } from '../../types/customDocument.js';
import { ValueOf } from '../../types/typelogic.js';
import { OutcomeStatus, Outcome, LimitedCommandInteraction, OptionValidationErrorOutcome, Constraint, OptionValidationErrorStatus, LimitedCommandInteractionOption, ALWAYS_OPTION_CONSTRAINT, validateConstraints, OptionValidationError, SlashCommandDescribedOutcome, OutcomeWithMonoBody, defaultSlashCommandDescriptions, SlashCommandEmbedDescribedOutcome, isEmbedDescribedOutcome, RendezvousMessageCommand } from 'discord-rendezvous';

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
enum ApproveSubmissionSpecificStatus {
    SUCCESS_NO_CHANGE = 'SUCCESS_NO_CHANGE',
    SUCCESS_SUBMISSION_REVIEWED = 'SUCCESS_SUBMISSION_REVIEWED',
    SUCCESS_SUBMISSION_APPEALED = 'SUCCESS_SUBMISSION_APPEALED',
}

/**
 * Union of specific and generic status codes.
 */
type ApproveSubmissionStatus = ApproveSubmissionSpecificStatus | OutcomeStatus;

/**
 * The outcome format for the specific status code(s).
 */
type ApproveSubmissionSuccessOutcome = {
    status: ApproveSubmissionSpecificStatus.SUCCESS_NO_CHANGE | ApproveSubmissionSpecificStatus.SUCCESS_SUBMISSION_APPEALED | ApproveSubmissionSpecificStatus.SUCCESS_SUBMISSION_REVIEWED;
    body: {
        user: string;
        challenge: ResolvedChallenge;
    };
};

/**
 * Union of specific and generic outcomes.
 */
type ApproveSubmissionOutcome = Outcome<T1, T2, ApproveSubmissionSuccessOutcome>;

interface ApproveSubmissionSolverParams {
    guildId: string;
    contestantId: string;
    judgeId: string;
    messageContents: string;
}

const approveSubmissionSolver = async (params: ApproveSubmissionSolverParams): Promise<ApproveSubmissionOutcome> => {
    // Get the current tournament, Judge, and Contestant
    const tournament = await getCurrentTournament(params.guildId);
    if (!tournament) return {
        status: OutcomeStatus.FAIL_DNE_MONO,
        body: {
            data: '(currentTournament)',
            context: 'tournament',
        },
    };
    const judge = await getJudgeByGuildIdAndMemberId(params.guildId, params.judgeId);
    if (!judge) return {
        status: OutcomeStatus.FAIL_DNE_MONO,
        body: {
            data: '(judge)',
            context: 'judge',
        },
    };
    const contestant = await getContestantByGuildIdAndMemberId(params.guildId, params.contestantId);
    if (!contestant) return {
        status: OutcomeStatus.FAIL_DNE_MONO,
        body: {
            data: '(contestant)',
            context: 'contestant',
        },
    };

    // Get the first link in the message
    const link = params.messageContents.match(/https?:\/\/[^\s]+/)?.[0];
    if (!link) return {
        status: OutcomeStatus.FAIL,
        body: {},
    };
    // Find the submissions from the contestant in the current tournament that have this link
    const submission = await getSubmissionInCurrentTournamentFromContestantWithLink(params.guildId, contestant, link);
    if (!submission) return {
        status: OutcomeStatus.FAIL_DNE_MONO,
        body: {
            data: '(submission)',
            context: 'submission',
        },
    };

    // Get the challenge details for display purposes
    const challenge = await getChallengeById(submission.challengeID);
    if (!challenge) return {
        status: OutcomeStatus.FAIL_DNE_MONO,
        body: {
            data: '(challenge)',
            context: 'challenge',
        },
    };

    // Create a ReviewNote for this submission, reusing logic from /judge-submission
    const result = await makeReviewNoteAndInterpretResult(submission, judge, true);
    let status: ApproveSubmissionSpecificStatus;
    if (result === MakeReviewNoteAndInterpretResultOutcomeStatus.SUCCESS_NO_CHANGE) {
        status = ApproveSubmissionSpecificStatus.SUCCESS_NO_CHANGE;
    } else if (result === MakeReviewNoteAndInterpretResultOutcomeStatus.SUCCESS_SUBMISSION_REVIEWED) {
        status = ApproveSubmissionSpecificStatus.SUCCESS_SUBMISSION_REVIEWED;
    } else if (result === MakeReviewNoteAndInterpretResultOutcomeStatus.SUCCESS_SUBMISSION_APPEALED) {
        status = ApproveSubmissionSpecificStatus.SUCCESS_SUBMISSION_APPEALED;
    } else {
        return {
            status: OutcomeStatus.FAIL_UNKNOWN,
            body: {},
        };
    }
    return {
        status,
        body: {
            user: params.contestantId,
            challenge: await new ResolvedChallenge(challenge).make(),
        },
    };
};

const approveSubmissionMessageCommandValidator = async (interaction: LimitedCommandInteraction): Promise<ApproveSubmissionSolverParams | OptionValidationErrorOutcome<T1>> => {
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
        ['targetMessage', [
            // Ensure that the bot has permission to read this message's contents
            {
                category: OptionValidationErrorStatus.INSUFFICIENT_PERMISSIONS,
                func: async function(metadata: ValueOf<LimitedCommandInteraction>): Promise<boolean> {
                    try {
                        await (metadata as Message).fetch();
                        return true;
                    } catch (err) {
                        return false;
                    }
                },
            },
            // Ensure that the message contains a link or file upload
            {
                category: OptionValidationErrorStatus.OPTION_INVALID,
                func: async function(metadata: ValueOf<LimitedCommandInteraction>): Promise<boolean> {
                    return (metadata as Message).content.match(/https?:\/\/[^\s]+/)?.[0] !== undefined || (metadata as Message).attachments.size > 0;
                },
            },
        ]],
    ]);

    const optionConstraints = new Map<LimitedCommandInteractionOption | null | ALWAYS_OPTION_CONSTRAINT, Constraint<ValueOf<LimitedCommandInteractionOption>>[]>([]);

    let proofLink: string;
    let contestantId: string;

    try {
        if (interaction.targetMessage!.attachments.size > 0) proofLink = interaction.targetMessage!.url;
        // nullish coalescing on .match() to appease linter -- we know from constraints above a link is present in this else case
        else proofLink = interaction.targetMessage!.content.match(/https?:\/\/[^\s]+/)?.[0] ?? '';
        contestantId = interaction.targetMessage!.author.id;

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
        judgeId: interaction.member!.user.id,
        contestantId,
        messageContents: proofLink,
    };
};

const approveSubmissionSlashCommandDescriptions = new Map<ApproveSubmissionStatus, (o: ApproveSubmissionOutcome) => SlashCommandDescribedOutcome>([
    [ApproveSubmissionSpecificStatus.SUCCESS_SUBMISSION_REVIEWED, (o: ApproveSubmissionOutcome) => {
        const oBody = (o as ApproveSubmissionSuccessOutcome).body;
        return {
            userMessage: `✅ <@${oBody.user}>'s submission for ${oBody.challenge.difficulty?.emoji ? oBody.challenge.difficulty.emoji + ' ' : ''}**${oBody.challenge.name}** approved!`, ephemeral: true
        };
    }],
    [ApproveSubmissionSpecificStatus.SUCCESS_SUBMISSION_APPEALED, (o: ApproveSubmissionOutcome) => {
        const oBody = (o as ApproveSubmissionSuccessOutcome).body;
        return {
            userMessage: `✅ <@${oBody.user}>'s previously rejected submission for ${oBody.challenge.difficulty?.emoji ? oBody.challenge.difficulty.emoji + ' ' : ''}**${oBody.challenge.name}** approved!`, ephemeral: true
        };
    }],
    [ApproveSubmissionSpecificStatus.SUCCESS_NO_CHANGE, (o: ApproveSubmissionOutcome) => {
        const oBody = (o as ApproveSubmissionSuccessOutcome).body;
        return {
            userMessage: `✅ <@${oBody.user}>'s submission for ${oBody.challenge.difficulty?.emoji ? oBody.challenge.difficulty.emoji + ' ' : ''}**${oBody.challenge.name}** was already approved.`, ephemeral: true
        };
    }],
    [OutcomeStatus.FAIL_DNE_MONO, (o: ApproveSubmissionOutcome) => {
        const oBody = (o as OutcomeWithMonoBody<T1>).body;
        if (oBody.context === 'tournament') return {
            userMessage: `❌ There is no current tournament.`, ephemeral: true
        };
        else if (oBody.context === 'submission') return {
            userMessage: `❌ This message does not appear to have an associated submission.`, ephemeral: true
        };
        else return {
            userMessage: `❌ This command failed unexpectedly.`, ephemeral: true
        };
    }],
    [OutcomeStatus.FAIL_VALIDATION, (o: ApproveSubmissionOutcome) => {
        const oBody = (o as OptionValidationErrorOutcome<T1>).body;
        if (oBody.constraint.category === OptionValidationErrorStatus.INSUFFICIENT_PERMISSIONS) {
            if (oBody.field === 'member') return {
                userMessage: `❌ You do not have permission to use this command.`, ephemeral: true
            };
            else return {
                userMessage: `❌ This command requires the contestant to tag the bot in their message due to Discord's privacy restrictions.`, ephemeral: true
            };
        } else if (oBody.constraint.category === OptionValidationErrorStatus.OPTION_INVALID) return {
            userMessage: `❌ This message does not have a link or file upload.`, ephemeral: true
        };
        else return {
            userMessage: `❌ This command failed unexpectedly.`, ephemeral: true
        };
    }],
]);

const approveSubmissionMessageCommandDescriber = (outcome: ApproveSubmissionOutcome): SlashCommandDescribedOutcome => {
    if (approveSubmissionSlashCommandDescriptions.has(outcome.status as ApproveSubmissionStatus)) return approveSubmissionSlashCommandDescriptions.get(outcome.status as ApproveSubmissionStatus)!(outcome);
    // Fallback to trying default descriptions
    const defaultOutcome = outcome as unknown as Outcome<string>;
    if (defaultSlashCommandDescriptions.has(defaultOutcome.status)) {
        return defaultSlashCommandDescriptions.get(defaultOutcome.status)!(defaultOutcome);
    } else return defaultSlashCommandDescriptions.get(OutcomeStatus.FAIL_UNKNOWN)!(defaultOutcome);
};

const approveSubmissionMessageCommandReplyer = async (interaction: CommandInteraction, describedOutcome: SlashCommandDescribedOutcome | SlashCommandEmbedDescribedOutcome) => {
    if (isEmbedDescribedOutcome(describedOutcome)) return interaction.reply({ embeds: describedOutcome.embeds, components: describedOutcome.components, ephemeral: describedOutcome.ephemeral });
    else return interaction.reply({ content: describedOutcome.userMessage, ephemeral: describedOutcome.ephemeral });
};

const ApproveSubmissionCommand = new RendezvousMessageCommand<ApproveSubmissionOutcome, ApproveSubmissionSolverParams, T1>(
    new ContextMenuCommandBuilder()
        .setName('Approve Submission')
        .setType(ApplicationCommandType.Message) as ContextMenuCommandBuilder,
    approveSubmissionMessageCommandReplyer,
    approveSubmissionMessageCommandDescriber,
    approveSubmissionMessageCommandValidator,
    approveSubmissionSolver,
);

export default ApproveSubmissionCommand;