export class DomainError extends Error {
    constructor(message: string, public code: string = "DOMAIN_ERROR", public status: number = 400) {
        super(message);
        this.name = this.constructor.name;
    }
}

export class ValidationError extends DomainError {
    constructor(message: string, public details?: unknown) {
        super(message, "VALIDATION_ERROR", 400);
    }
}

export class UnauthorizedError extends DomainError {
    constructor(message: string = "Not authorized") {
        super(message, "UNAUTHORIZED", 401);
    }
}

export class ForbiddenError extends DomainError {
    constructor(message: string = "Forbidden") {
        super(message, "FORBIDDEN", 403);
    }
}
