/** Two-digit zero padding for clock, date and duration text. */
export const pad2 = (n: number): string => String(n).padStart(2, '0')

/** The message of a caught value. Host and CLI errors are read as Errors, as they always were. */
export const messageOf = (error: unknown): string => (error as Error).message
