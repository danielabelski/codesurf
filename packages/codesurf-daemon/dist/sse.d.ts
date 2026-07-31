export interface ParsedSseJsonBuffer<T> {
    events: T[];
    errors: Error[];
    remaining: string;
}
export declare function parseSseJsonBuffer<T = unknown>(buffer: string): ParsedSseJsonBuffer<T>;
