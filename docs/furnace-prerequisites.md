# Furnace prerequisites for smelting

When no furnace is reachable, `smelt_ores` now checks physical crafting prerequisites instead of silently attempting a table-only recipe without a table.

Order: place a carried furnace; otherwise require8cobblestone, use a reachable crafting table, place a carried table, or craft one from available planks/logs and place it. Missing wood, failed crafting and failed placement produce specific failure messages. Table crafting preserves some wood when it is the only fuel. No materials are granted and no teleport is used.

Both table and furnace placement inspect the exact target block. A nearby unrelated furnace cannot turn a failed placement into success. Cancellation stops subsequent inventory/world mutations; blocks already placed before cancellation remain in the world.

Validation:20fake-bot production-helper tests plus existing smelting regressions. On Node22, all1064tests, typecheck and build pass. Node24 has an unrelated existing symlink-cleanup assertion incompatibility. Repository-wide formatting currently fails in10untouched files; scoped files are formatted. Three actual isolated Paper fixtures also pass: carried table, craftable table from4planks, and missing-wood failure. Independent server block/inventory observations confirmed the furnace placements and preserved materials in the negative case. Fixtures used disposable fresh worlds, not the live swarm world; this validates prerequisites, not autonomous advancement performance.
