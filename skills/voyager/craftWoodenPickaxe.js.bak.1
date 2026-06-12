async function craftWoodenPickaxe(bot) {
  const craftingTableCount = bot.inventory.count(mcData.itemsByName.crafting_table.id);
  if (craftingTableCount === 0) {
    await craftCraftingTable(bot);
  }

  const planksCount = bot.inventory.items()
    .filter(i => i.name.endsWith("_planks"))
    .reduce((s, i) => s + i.count, 0);

  if (planksCount < 3) {
    const logItem = bot.inventory.items().find(i => i.name.endsWith("_log"));
    if (logItem) {
      await craftItem(bot, logItem.name.replace("_log", "_planks"), 1);
      bot.chat("Crafted planks from logs.");
    } else {
      try {
        await mineBlock(bot, "oak_log", 1);
        await craftItem(bot, "oak_planks", 1);
        bot.chat("Mined and crafted oak planks.");
      } catch (e) {
        throw new Error("Cannot find any wood nearby — need wood to craft planks for wooden pickaxe");
      }
    }
  }

  const sticksCount = bot.inventory.count(mcData.itemsByName.stick.id);
  if (sticksCount < 2) {
    await craftItem(bot, "stick", 1);
    bot.chat("Crafted sticks.");
  }

  const craftingTablePosition = bot.entity.position.offset(1, 0, 0);
  await placeItem(bot, "crafting_table", craftingTablePosition);

  await craftItem(bot, "wooden_pickaxe", 1);
  bot.chat("Crafted a wooden pickaxe.");
}
