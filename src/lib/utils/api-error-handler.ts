import { NextResponse } from "next/server";
import { DomainError, ValidationError } from "./errors";

export function handleControllerError(error: unknown, context: string) {
    console.error(`Error in ${context}:`, error);

    if (error instanceof DomainError) {
        return NextResponse.json(
            {
                error: error.message,
                code: error.code,
                details: error instanceof ValidationError ? error.details : undefined
            },
            { status: error.status }
        );
    }

    return NextResponse.json(
        { error: "Internal server error" },
        { status: 500 }
    );
}
