import { inspect } from 'node:util';
export default async function* reporter(source) {
    for await (const event of source) {
        if (event.type === 'test:fail') yield `FAIL ${event.data.name}: ${inspect(event.data.details.error, { depth: 4, colors: false })}\n`;
        if (event.type === 'test:summary' && event.data.file === undefined)
            yield `${event.data.counts.tests} tests: ${event.data.counts.passed} passed, ${event.data.counts.failed} failed, ${event.data.counts.skipped} skipped\n`;
    }
}
