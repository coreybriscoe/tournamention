export class DuplicateSubdocumentError extends Error {
    constructor(message: string) {
        super(message);
        this.name = 'DuplicateSubdocumentError';
    }
}

/**
 * This error is currently unused in the codebase. In most use cases, it is preferable to use the 
 * getOrCreateGuildSettings() function rather than throw and/or handle this error manually.
 */
export class NonexistentGuildError extends Error {
    constructor(public guildID: string) {
        super(`Guild with ID ${guildID} does not exist in the database.`);
        this.name = 'NonexistentGuildError';
    }
}

/**
 * Generic error for when a specified document is not found in the database.
 * Currently unused in the codebase.
 */
export class NonexistentDocumentError extends Error {
    constructor(public documentId: string) {
        super(`Document with ID ${documentId} does not exist in the database.`);
        this.name = 'NonexistentDocumentError';
    }
}

/**
 * Error for when a document in a model compound-indexed by guild ID and user ID is not found.
 */
export class NonexistentJointGuildAndMemberError extends Error {
    constructor(public guildId: string, public memberId: string) {
        super(`Document with guild ID of ${guildId} and member of ID ${memberId} does not exist.`);
        this.name = 'NonexistentJointGuildAndMemberError';
    }
}

/**
 * For error handling near user-facing code, this abstract class provides an additional property 
 * `userMessage` extending classes can use to provide a response to the user's slash command
 * indicating what went wrong.
 */
export abstract class UserFacingError extends Error {
    constructor(message: string, public readonly userMessage: string) {
        super(message);
        this.name = 'UserFacingError';
    }
}

/**
 * A 'base' `UserFacingError` class for errors that do not have a specific type.
 */
export class UserMessageError extends UserFacingError {
    constructor(message: string, userMessage: string) {
        super(message, userMessage);
        this.name = 'UserMessageError';
    }
}

/**
 * An error thrown for inexplicable situations, such as APIs returning unexpected data.
 */
export class UnknownError extends Error {
    constructor(message: string) {
        super(message);
        this.name = 'UnknownError';
    }
}