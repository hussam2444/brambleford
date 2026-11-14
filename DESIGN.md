# Brambleford (working title)

A cozy, top-down pixel-art market town for the NEAR Hackathon track
**Games With Real Economies**. You gather things, sell them to shopkeepers,
and slowly buy your way into owning the town. Every shopkeeper is an agent
with its own purse and stock, so prices are real consequences, not a table.

Reference feel: Stardew Valley's town and shops. Not a trading terminal.

## The loop

| Timescale | What the player does | What they feel |
|---|---|---|
| Every 30 seconds | Swing at a rock, tree, wheat patch or fishing spot; or walk to a shop and sell | "I got something, and the price moved because of me" |
| Every 2 to 3 minutes (one game day) | Read the notice board, fill a shopkeeper's order for the bonus, spend the day's energy, pick who to sell to, buy bread to keep going | "I timed that well" or "I should have waited" |
| Every session | Buy tools to gather faster, buy into a shop for a share of its profit, rescue a shop that went under, climb from Newcomer to Alderman | "Part of this town is mine" |

## First minute (no tutorial screen)

1. You appear in the town square with 20 coins and an empty bag.
2. A rock by the mine sparkles. Walk up, press **E**, get ore.
3. A yellow arrow points at the blacksmith. Walk up, press **E**, sell.
4. Her price for ore drops a little as you sell. That is the whole game in one beat.

## The town

- **Four shopkeepers**: Bruna (blacksmith: ore + wood into tools), Odo (baker:
  wheat into bread), Maren (fishmonger: fish into smoked fish), Tobin
  (carpenter: wood into furniture).
- **Four places to gather**: the mine, the forest, the wheat field, the river.
- **Townsfolk** buy what the shops make and earn the rent and wages the shops pay.
- **Coins are conserved.** They move between shops, townsfolk and players and
  are never created or destroyed. `npm run sim` checks this on every run.

## Rules of the economy (all in `src/economy/`)

- `pricing.ts` is the one file that decides a price. A shop pays more when it
  is short of something and less when it has plenty; it charges more when trade
  is brisk; it pays less when its purse is thin; it never sells below cost.
  Each quote comes with the shopkeeper's reasoning in plain words (the tooltip).
- `town.ts` runs the hour: gatherers sell to shops, shops make goods,
  townsfolk buy, and at day's end shops pay rent. Two missed rents and a shop
  shuts until a player invests, or until the townsfolk club together three
  days later and reopen it from their own purse.
- Supply shocks (blight, a mine collapse, a salmon run) arrive on their own and
  move prices for a few days.
- Each morning the shopkeepers shortest of something pin an order to the
  notice board. Whoever brings all of it first is paid a bonus out of that
  shopkeeper's own purse, so no coin is made.
- A player's standing is their worth (coins, goods at their usual price, and
  shop shares) and how many shops they own part of: Newcomer, Trader,
  Merchant, Burgher, Alderman.
- Once a day each shopkeeper may change how much it keeps on the shelf. A
  language model decides, shown only that shop's books, and its answer is held
  to small steps inside fixed limits. The shopkeeper's own account signs it.

## What "you never notice the chain" means here

| The player sees | What happens underneath |
|---|---|
| The game just starts | A NEAR account is created for the browser's key |
| Items in a bag | NEP-245 multi-token balances in one contract |
| A shopkeeper with a purse and a plan | A NEAR account with its own key; only it can change its plan, and the chain records which model thought it through |
| An order on the notice board | Part of the town's state in the contract; the bonus is a transfer from the shopkeeper's balance |
| "Sign in with Google" (optional) | One NEAR account per person, with a key for each browser they use |
| Selling an item | One gasless transaction, sent by our relayer |
| "You own 25% of the bakery" | A share token in the same contract |

## Where it stands

Built: the playable town, the economy, the NEAR contract (live on testnet at
`brambleford.testnet`), guest accounts with no wallet, gasless trades, the
time-lapse, wanted orders and standing, optional sign-in with Google,
shopkeepers whose daily plan is made by a model on NEAR AI Cloud and signed
with their own keys, and a timer that keeps the town's hours with nobody there.

Not built: other players visible in the same town, a "while you were away"
summary, a fifth shop, crafting by the player, talking to a shopkeeper in your
own words. The README lists the known limits.
