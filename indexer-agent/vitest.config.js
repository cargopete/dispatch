import { defineConfig } from "vitest/config";
export default defineConfig({
    test: {
        environment: "node",
        testTimeout: 120_000,
        hookTimeout: 60_000,
        // Tests share Anvil state and must run in declaration order.
        sequence: { concurrent: false },
    },
});
