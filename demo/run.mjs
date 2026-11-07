// Starts the demo bundle. Importing it instead of running it as the entry file keeps the CLI's own
// "run main when invoked directly" check from firing a second time inside the bundle.
await import('./build/demo.mjs');
