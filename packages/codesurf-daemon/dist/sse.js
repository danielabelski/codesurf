export function parseSseJsonBuffer(buffer) {
    const events = [];
    const errors = [];
    let remaining = buffer;
    let boundary = remaining.indexOf('\n\n');
    while (boundary >= 0) {
        const chunk = remaining.slice(0, boundary);
        remaining = remaining.slice(boundary + 2);
        const dataLines = chunk
            .split('\n')
            .filter(line => line.startsWith('data:'))
            .map(line => line.slice(5).trim());
        if (dataLines.length > 0) {
            try {
                events.push(JSON.parse(dataLines.join('\n')));
            }
            catch (error) {
                errors.push(error instanceof Error ? error : new Error(String(error)));
            }
        }
        boundary = remaining.indexOf('\n\n');
    }
    return { events, errors, remaining };
}
