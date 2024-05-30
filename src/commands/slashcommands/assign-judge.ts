import { SlashCommandBuilder } from '@discordjs/builders';
import { GuildMember, PermissionsBitField, User } from 'discord.js';
import { NonexistentJointGuildAndMemberError, UnknownError } from '../../types/customError.js';
import { setJudgeActive, setOrCreateActiveJudge } from '../../backend/queries/profileQueries.js';
import { ValueOf } from '../../types/typelogic.js';
import { OutcomeStatus, Outcome, LimitedCommandInteraction, OptionValidationErrorOutcome, Constraint, OptionValidationErrorStatus, LimitedCommandInteractionOption, validateConstraints, OptionValidationError, SlashCommandDescribedOutcome, OutcomeWithDuoListBody, OutcomeWithDuoBody, SimpleRendezvousSlashCommand } from 'discord-rendezvous';

/**
 * Alias for the first generic type of the command.
 */
type T1 = string | boolean;

/**
 * Alias for the second generic type of the command.
 */
type T2 = string | boolean;

/**
 * Status codes specific to this command.
 */
enum AssignJudgeSpecificStatus {
    SUCCESS_JUDGE_UPDATED = 'SUCCESS_JUDGE_UPDATED',
    SUCCESS_JUDGE_CREATED = 'SUCCESS_JUDGE_CREATED',
}

/**
 * Union of specific and generic status codes.
 */
type AssignJudgeStatus = AssignJudgeSpecificStatus | OutcomeStatus;

/**
 * The outcome format for the specific status code(s).
 */
type AssignJudgeSuccessJudgeUpdatedOutcome = {
    status: AssignJudgeSpecificStatus.SUCCESS_JUDGE_UPDATED;
    body: {
        user: string;
        active: boolean;
    };
}

type AssignJudgeSuccessJudgeCreatedOutcome = {
    status: AssignJudgeSpecificStatus.SUCCESS_JUDGE_CREATED;
    body: {
        user: string;
    };
};

/**
 * Union of specific and generic outcomes.
 */
type AssignJudgeOutcome = Outcome<T1, T2, AssignJudgeSuccessJudgeUpdatedOutcome | AssignJudgeSuccessJudgeCreatedOutcome>;

/**
 * Parameters for the solver function, as well as the "S" generic type.
 */
interface AssignJudgeSolverParams {
    guildId: string;
    memberId: string;
    revoke: boolean;
}

/**
 * Assigns a member the Judge privilege, or revokes it.
 * @param params The parameters object for the solver function.
 * @returns An `AssignJudgeOutcome`, in all cases.
 */
const assignJudgeSolver = async (params: AssignJudgeSolverParams): Promise<AssignJudgeOutcome> => {
    try {
        const result = await (params.revoke ? setJudgeActive(params.guildId, params.memberId, false) : setOrCreateActiveJudge(params.guildId, params.memberId));
        if (result.matchedCount === 1 && result.modifiedCount === 0) return ({
            // The Judge already exists and is already in the desired state
            status: OutcomeStatus.SUCCESS_NO_CHANGE,
            body: {
                data1: [params.memberId],
                context1: 'memberId',
                data2: [!params.revoke],
                context2: 'isActiveJudge',
            },
        });
        if (result.matchedCount === 1 && result.modifiedCount === 1) return ({
            // The Judge already exists and was modified to the desired state
            status: AssignJudgeSpecificStatus.SUCCESS_JUDGE_UPDATED,
            body: {
                user: params.memberId,
                active: params.revoke ? false : true,
            },
        });
        if (result.matchedCount === 0 && (result.upsertedCount === 1 || !params.revoke)) return ({
            // The Judge did not exist and was created with an active status, or they (ineffectually) tried to unrevoke a nonexistent Judge
            status: AssignJudgeSpecificStatus.SUCCESS_JUDGE_CREATED,
            body: {
                user: params.memberId,
            },
        });
        if (result.matchedCount === 0) {
            // The Judge did not exist and was not created -- i.e. they tried to revoke a nonexistent Judge
            throw new NonexistentJointGuildAndMemberError(params.guildId, params.memberId);
        } else throw new UnknownError(`Error in assign-judge.ts: Unexpected query result: ${result}.`);
    } catch (err) {
        if (err instanceof NonexistentJointGuildAndMemberError) return ({
            status: OutcomeStatus.FAIL_DNE_DUO,
            body: {
                data1: err.guildId,
                context1: 'guildId',
                data2: err.memberId,
                context2: 'memberId',
            }
        });
    }

    return {
        status: OutcomeStatus.FAIL_UNKNOWN,
        body: {},
    };
};

const assignJudgeSlashCommandValidator = async (interaction: LimitedCommandInteraction): Promise<AssignJudgeSolverParams | OptionValidationErrorOutcome<T1>> => {
    let guildId: string;
    let targetId: string;
    let revoke: boolean;

    const who = interaction.options.get('who', true);

    const metadataConstraints = new Map<keyof LimitedCommandInteraction, Constraint<ValueOf<LimitedCommandInteraction>>[]>([
        ['member', [
            // Ensure that the sender is an Administrator
            {
                category: OptionValidationErrorStatus.INSUFFICIENT_PERMISSIONS,
                func: async function(metadata: ValueOf<LimitedCommandInteraction>): Promise<boolean> {
                    return (metadata as GuildMember).permissions.has(PermissionsBitField.Flags.Administrator);
                },
            },
        ]]
    ]);

    const optionConstraints = new Map<LimitedCommandInteractionOption, Constraint<ValueOf<LimitedCommandInteractionOption>>[]>([
        [who, [
            // Ensure that the target is not a bot
            {
                category: OptionValidationErrorStatus.TARGET_USER_BOT,
                func: async function(option: ValueOf<LimitedCommandInteractionOption>): Promise<boolean> {
                    return new Promise(function(resolve) {
                        resolve(!(option as User).bot);
                    });
                },
            },
        ]],
    ]);

    try {
        guildId = interaction.guildId!;
        targetId = who.user!.id;
        revoke = interaction.options.get('revoke', false)?.value as boolean;

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
        memberId: targetId,
        revoke: revoke,
    };
};

const assignJudgeSlashCommandDescriptions = new Map<AssignJudgeStatus, (o: AssignJudgeOutcome) => SlashCommandDescribedOutcome>([
    [AssignJudgeSpecificStatus.SUCCESS_JUDGE_UPDATED, (o: AssignJudgeOutcome) => ({
        userMessage: `✅ <@${(o as AssignJudgeSuccessJudgeUpdatedOutcome).body.user}> is ${(o as AssignJudgeSuccessJudgeUpdatedOutcome).body.active ? 'now an active judge!' : 'no longer an active judge.'}`, ephemeral: true   
    })],
    [AssignJudgeSpecificStatus.SUCCESS_JUDGE_CREATED, (o: AssignJudgeOutcome) => ({
        userMessage: `✅ <@${(o as AssignJudgeSuccessJudgeCreatedOutcome).body.user}> is now a new judge!`, ephemeral: true   
    })],
    [OutcomeStatus.SUCCESS_NO_CHANGE, (o: AssignJudgeOutcome) => ({
        userMessage: `✅ <@${(o as OutcomeWithDuoListBody<T1, T2>).body.data1[0]}> is already ${(o as OutcomeWithDuoListBody<T1, T2>).body.data2[0] ? '' : 'not '}a judge.`, ephemeral: true   
    })],
    [OutcomeStatus.FAIL_DNE_DUO, (o: AssignJudgeOutcome) => ({
        userMessage: `❌ <@${(o as OutcomeWithDuoBody<T1>).body.data2}> is not a judge, so you cannot revoke them.`, ephemeral: true   
    })],
]);


const AssignJudgeSlashCommand = new SimpleRendezvousSlashCommand<AssignJudgeOutcome, AssignJudgeSolverParams, T1, AssignJudgeStatus>(
    new SlashCommandBuilder()
        .setName('assign-judge')
        .setDescription('Assign someone as a judge for challenge submissions in all tournaments, or revoke judge permissions.')
        .addUserOption(option => option.setName('who').setDescription('The new judge to assign, or whose permissions to modify.').setRequired(true))
        .addBooleanOption(option => option.setName('revoke').setDescription('To revoke an existing judge, use True. To re-assign a judge, use False or leave this blank.').setRequired(false)) as SlashCommandBuilder,
    assignJudgeSlashCommandDescriptions,
    assignJudgeSlashCommandValidator,
    assignJudgeSolver,
);

export default AssignJudgeSlashCommand;