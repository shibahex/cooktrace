/**
 * AI Chat — multi-provider Trace assistant with tool use (function calling).
 *
 * Mirrors the NutriTrace + LiftTrace pattern so users get a consistent
 * Trace experience across all three apps. Supports Anthropic Claude,
 * OpenAI, Google Gemini, and OpenAI-compatible endpoints (Ollama, LM
 * Studio, vLLM, DeepSeek, Groq, etc.).
 *
 * Tool use flow:
 *   1. Send messages + tool definitions to the model
 *   2. If model responds with tool_use, execute via the registered
 *      handler and feed results back
 *   3. Repeat until the model answers without calling a tool
 *
 * The tool catalog is defined alongside the executor in this file
 * (see TOOLS below). Trace.svelte owns the executor implementation
 * via setToolHandler(), keeping the catalog and execution code
 * loosely coupled so we can iterate on either independently.
 */
import { getOpenAIChatParams } from './openai-chat-params.js';

// ── Provider catalog (kept in CookTrace's `id`-keyed shape so the
//    existing SettingsTrace dropdown keeps working). ───────────────────────
export const AI_PROVIDERS = [
  { id: 'claude',  label: 'Anthropic Claude' },
  { id: 'openai',  label: 'OpenAI' },
  { id: 'gemini',  label: 'Google Gemini' },
  { id: 'custom',  label: 'OpenAI Compatible' },
];

export const AI_DEFAULT_MODELS = {
  claude:  'claude-haiku-4-5-20251001',
  openai:  'gpt-5.6-luna',
  gemini:  'gemini-3.6-flash',
  custom:  '',
};

// Sentinel appended to each branded provider's model list. When the select
// value is this sentinel, the UI reveals a free-text input so users can
// enter a model ID we haven't hardcoded (e.g. after a vendor renames).
export const AI_MODEL_CUSTOM = '__custom__';

export const AI_MODELS = {
  claude:  ['claude-haiku-4-5-20251001', 'claude-sonnet-5', 'claude-opus-5', 'claude-fable-5-1', 'claude-fable-5', 'claude-opus-4-8', AI_MODEL_CUSTOM],
  openai:  ['gpt-5.6-luna', 'gpt-5.6-terra', 'gpt-5.6', 'gpt-4o-mini', 'gpt-4o', AI_MODEL_CUSTOM],
  gemini:  ['gemini-3.5-flash-lite', 'gemini-3.6-flash', 'gemini-3.1-pro', 'gemini-2.5-flash-lite', 'gemini-2.5-flash', 'gemini-2.5-pro', AI_MODEL_CUSTOM],
  custom:  [],
};

// ── Tool definitions (cooking-domain) ────────────────────────────────────────
export const TOOLS = [
  // Read tools
  {
    name: 'get_recipes',
    description: "Get recipes from the family recipe box: the user's own and everyone else's that they can see. Returns each recipe's id, name, description, servings, prep+cook minutes, rating, favorite, last_cooked_at, cook_count, category, tags, pantry_match, owner (the account that made it) and household. Use this to find a recipe by name, browse the library, or find every recipe a given account made. Returns every match (no cap) unless you pass limit.",
    parameters: {
      type: 'object',
      properties: {
        query:     { type: 'string', description: 'Optional case-insensitive name/description/tag filter. Omit to return all.' },
        category:  { type: 'string', description: 'Optional case-insensitive category name filter (e.g. "Desserts", "Italian"). Use list_recipe_categories first to see what exists.' },
        favorite:  { type: 'boolean', description: 'If true, only return favorited recipes.' },
        owner:     { type: 'string', description: 'Optional: only recipes made by this account (case-insensitive match on the account\'s name or username, e.g. "Family").' },
        household: { type: 'string', description: 'Optional: only recipes in this household (name or id). Pass "none" for recipes in no household.' },
        mine_only: { type: 'boolean', description: 'If true, only the signed-in user\'s own recipes. Default false (everyone\'s).' },
        brief:     { type: 'boolean', description: 'If true, return only id, name, owner and household per recipe. Use this for bulk jobs over many recipes.' },
        limit:     { type: 'integer', description: 'Optional maximum number of recipes to return. Omit for all.' },
        offset:    { type: 'integer', description: 'Optional number of matches to skip (for paging with limit).' },
      },
    },
  },
  {
    name: 'list_households',
    description: "List the family's households: id, name, owner, members, how many recipes are in each, and whether the user can use it (only usable households can receive recipes). Call this to find a household's id by name before set_recipe_household.",
    parameters: { type: 'object', properties: {} },
  },
  {
    name: 'list_recipe_categories',
    description: "List all recipe categories in the user's catalog with name, slug, color, and how many recipes are in each. Use before filtering get_recipes by category to know what's available.",
    parameters: { type: 'object', properties: {} },
  },
  {
    name: 'get_recipe',
    description: 'Get a single recipe with full ingredients (grouped), steps, tools (Kitchen Gear), tags, source URL, notes, and per-serving nutrition.',
    parameters: {
      type: 'object',
      properties: { id: { type: 'integer', description: 'Recipe id' } },
      required: ['id'],
    },
  },
  {
    name: 'get_pantry',
    description: "Get the user's pantry inventory. Each item has id, name, brand, in_stock, quantity, unit, expires_on, category, serving size + nutrition (when set), barcode, and notes. Use this to answer 'do I have X?' or feed into find_recipes_from_pantry.",
    parameters: {
      type: 'object',
      properties: {
        in_stock_only: { type: 'boolean', description: 'If true, only return items currently in stock.' },
        query:    { type: 'string', description: 'Optional case-insensitive name filter.' },
        category: { type: 'string', description: 'Optional case-insensitive category name filter (e.g. "Dairy & Eggs", "Produce"). Use list_pantry_categories first to see what exists.' },
      },
    },
  },
  {
    name: 'list_pantry_categories',
    description: "List all pantry categories in the user's catalog with name, slug, icon. Use before filtering get_pantry by category to know what's available.",
    parameters: { type: 'object', properties: {} },
  },
  {
    name: 'find_recipes_from_pantry',
    description: "Find recipes the user can mostly cook from what's currently in stock. Returns recipes ranked by pantry match ratio (have / need). Useful for 'what can I cook tonight?'.",
    parameters: {
      type: 'object',
      properties: {
        min_ratio: { type: 'number', description: 'Minimum match ratio 0-1 (default 0.7 = at least 70% in stock).' },
      },
    },
  },
  {
    name: 'get_diary',
    description: "Get the user's cook diary (past + planned cooks) for a date range. Returns date, kind ('cooked' | 'planned'), recipe_id, recipe_name, meal_type ('breakfast' | 'lunch' | 'dinner' | 'snack' | null), rating (1-5 or null — distinct from the recipe's overall rating; this is how THIS cook turned out), servings, notes, has_photo.",
    parameters: {
      type: 'object',
      properties: {
        from: { type: 'string', description: 'Start date (YYYY-MM-DD)' },
        to:   { type: 'string', description: 'End date (YYYY-MM-DD)' },
      },
      required: ['from', 'to'],
    },
  },
  {
    name: 'get_shopping_list',
    description: "Get the user's current shopping list. Each row: name, quantity, unit, aisle, checked status, pantry_id link, recipe_id, recipe_name (set when added from a recipe).",
    parameters: { type: 'object', properties: {} },
  },
  {
    name: 'get_cookbooks',
    description: "Get the user's cookbook collections. Returns id, name, slug, description, recipe_count, is_smart, smart_filter (for smart cookbooks).",
    parameters: { type: 'object', properties: {} },
  },
  {
    name: 'get_cookbook',
    description: 'Get one cookbook with the recipes inside (smart cookbooks evaluate the saved filter live).',
    parameters: {
      type: 'object',
      properties: { id: { type: 'integer', description: 'Cookbook id' } },
      required: ['id'],
    },
  },

  // Write tools
  {
    name: 'log_cook',
    description: "Mark a recipe as cooked on a given date. Updates the recipe's last_cooked_at + cook_count and creates a cook_diary entry. ONLY use this when the user says they cooked or ate it ('I cooked this' / 'just made the lasagna' / 'log that I made tacos last night'). Never use it to change a recipe's category, tags or anything else about the recipe: 'make these Dinner' / 'put these in Dinner' means update_recipes with category.",
    parameters: {
      type: 'object',
      properties: {
        recipe_id: { type: 'integer', description: 'Recipe id' },
        date:      { type: 'string',  description: 'YYYY-MM-DD; defaults to today.' },
        notes:     { type: 'string',  description: 'Optional cook notes.' },
        meal_type: { type: 'string',  description: "Optional meal slot — one of 'breakfast' | 'lunch' | 'dinner' | 'snack'. Use if the user mentioned which meal it was." },
        rating:    { type: 'integer', description: 'Optional 1-5 rating for THIS cook (not the recipe as a whole). Use when the user says "it turned out great" / "5 stars" / "meh".' },
      },
      required: ['recipe_id'],
    },
  },
  {
    name: 'plan_cook',
    description: "Schedule a recipe to be cooked on a future date (creates a kind='planned' diary entry). Use for 'plan tacos for Friday' / 'put pasta on the menu next Tuesday'.",
    parameters: {
      type: 'object',
      properties: {
        recipe_id: { type: 'integer', description: 'Recipe id' },
        date:      { type: 'string',  description: 'YYYY-MM-DD' },
        notes:     { type: 'string',  description: 'Optional notes.' },
        meal_type: { type: 'string',  description: "Optional meal slot — 'breakfast' | 'lunch' | 'dinner' | 'snack'." },
      },
      required: ['recipe_id', 'date'],
    },
  },
  {
    name: 'add_to_shopping',
    description: "Add one or more items to the user's shopping list. Each item is { name, quantity?, unit?, aisle? }. The server auto-links to existing pantry rows by name (case-insensitive).",
    parameters: {
      type: 'object',
      properties: {
        items: {
          type: 'array',
          description: 'Array of items to add.',
          items: {
            type: 'object',
            properties: {
              name:     { type: 'string',  description: 'Item name (e.g. "tomato")' },
              quantity: { type: 'number',  description: 'Optional numeric quantity.' },
              unit:     { type: 'string',  description: 'Optional unit (e.g. "cup", "lb").' },
              aisle:    { type: 'string',  description: 'Optional aisle (e.g. "Produce").' },
            },
            required: ['name'],
          },
        },
      },
      required: ['items'],
    },
  },
  {
    name: 'add_to_pantry',
    description: "Add a new pantry item (or update an existing one by name). Use for 'I just bought 2 lbs of chicken' / 'add olive oil to my pantry'.",
    parameters: {
      type: 'object',
      properties: {
        name:     { type: 'string',  description: 'Item name' },
        in_stock: { type: 'boolean', description: 'Whether currently in stock (default true)' },
        quantity: { type: 'number',  description: 'Optional numeric quantity' },
        unit:     { type: 'string',  description: 'Optional unit' },
        brand:    { type: 'string',  description: 'Optional brand' },
        notes:    { type: 'string',  description: 'Optional notes' },
      },
      required: ['name'],
    },
  },
  {
    name: 'set_pantry_density',
    description: "Set the volume↔weight density of a pantry item (grams per cup) so the recipe nutrition auto-calc can convert across families. Use this when the user asks 'set density for everything' / 'fill in densities for the dry goods'. Pull a sane default from your training: flour ~120, sugar ~200, oil ~218, butter ~227, honey ~340, water ~240, etc. The user can override per item later.",
    parameters: {
      type: 'object',
      properties: {
        pantry_id: { type: 'integer', description: 'Pantry item id' },
        g_per_cup: { type: 'number',  description: 'Grams per cup. Use null/0 to clear.' },
      },
      required: ['pantry_id', 'g_per_cup'],
    },
  },
  {
    name: 'set_pantry_stock',
    description: "Toggle whether a pantry item is in stock. Use for 'I'm out of butter' / 'I just restocked olive oil'. Pass the pantry_id from get_pantry.",
    parameters: {
      type: 'object',
      properties: {
        pantry_id: { type: 'integer', description: 'Pantry item id' },
        in_stock:  { type: 'boolean', description: 'true = in stock, false = out' },
      },
      required: ['pantry_id', 'in_stock'],
    },
  },
  {
    name: 'add_to_cookbook',
    description: 'Add one or more recipes to a (regular, non-smart) cookbook.',
    parameters: {
      type: 'object',
      properties: {
        cookbook_id: { type: 'integer', description: 'Cookbook id' },
        recipe_ids:  { type: 'array', items: { type: 'integer' }, description: 'Recipe ids to add' },
      },
      required: ['cookbook_id', 'recipe_ids'],
    },
  },
  {
    name: 'import_recipe_from_url',
    description: "Scrape a recipe from a public URL and save it. Works on most food blogs / publisher sites that publish schema.org/Recipe JSON-LD (which is the vast majority). Use this when the user pastes a URL or says 'import this from <site>'. The new recipe lands in their library and you should reference it by id afterwards (e.g. for log_cook).",
    parameters: {
      type: 'object',
      properties: {
        url:           { type: 'string',  description: 'Full URL of the recipe page.' },
        add_to_pantry: { type: 'boolean', description: 'If true (default), auto-create pantry rows for any new ingredient names. Set false if the user wants the recipe imported in isolation.' },
        apply_tags:    { type: 'boolean', description: 'If true, copy the publisher\'s tags onto the new recipe. Default false because publisher tags are usually noisy.' },
      },
      required: ['url'],
    },
  },
  {
    // ourfamily fork: households for Trace (see Trace.svelte).
    name: 'set_recipe_household',
    description: "Move one or many recipes into a household (or out of any household). Pass every recipe id in one call: there is no limit on how many. Typical flow: get_recipes with owner + brief=true to collect ids, then one set_recipe_household call. Returns how many moved and any that failed.",
    parameters: {
      type: 'object',
      properties: {
        recipe_ids: { type: 'array', items: { type: 'integer' }, description: 'Ids of the recipes to move.' },
        household:  { type: 'string', description: 'Target household name or id (case-insensitive name match). Pass "none" to take the recipes out of any household.' },
      },
      required: ['recipe_ids', 'household'],
    },
  },
  {
    name: 'create_recipe',
    description: "Create a brand-new recipe from scratch in chat. Use this when the user DICTATES a recipe (typed or via voice) OR attaches a photo of a cookbook page / handwritten card and asks you to import it. For a public web URL prefer import_recipe_from_url instead — it's cleaner and grabs the publisher's metadata. Ingredients should be the grouped shape: [{ name: '', items: [{ qty: '', unit: '', name: '', note: '' }, ...] }]. Steps as [{ title: '', text: '' }].",
    parameters: {
      type: 'object',
      properties: {
        name:         { type: 'string',  description: 'Recipe name (required).' },
        description:  { type: 'string',  description: 'Optional 1-2 sentence description.' },
        servings:     { type: 'integer', description: 'Optional servings count.' },
        yield_text:   { type: 'string',  description: 'Optional yield text, e.g. "12 cookies".' },
        prep_minutes: { type: 'integer', description: 'Optional prep minutes.' },
        cook_minutes: { type: 'integer', description: 'Optional cook minutes.' },
        ingredients: {
          type: 'array',
          description: 'Grouped ingredients. Single unnamed group is fine.',
          items: {
            type: 'object',
            properties: {
              name:  { type: 'string', description: 'Group name (e.g. "Sauce"). Empty string for default group.' },
              items: {
                type: 'array',
                items: {
                  type: 'object',
                  properties: {
                    qty:  { type: 'string', description: 'Quantity ("1", "1/2", "1.5")' },
                    unit: { type: 'string', description: 'Unit (cup, tbsp, oz, etc.)' },
                    name: { type: 'string', description: 'Ingredient name' },
                    note: { type: 'string', description: 'Optional prep note ("chopped", "sifted").' },
                  },
                  required: ['name'],
                },
              },
            },
            required: ['items'],
          },
        },
        steps: {
          type: 'array',
          description: 'Numbered instructions.',
          items: {
            type: 'object',
            properties: {
              title: { type: 'string', description: 'Optional short title (e.g. "Preheat Oven").' },
              text:  { type: 'string', description: 'Step text.' },
            },
            required: ['text'],
          },
        },
        tags:       { type: 'array', items: { type: 'string' }, description: 'Optional tags.' },
        tools:      { type: 'array', items: { type: 'string' }, description: 'Optional Kitchen Gear list.' },
        source_url: { type: 'string',  description: 'Optional URL the recipe came from.' },
        notes:      { type: 'string',  description: 'Optional author notes.' },
      },
      required: ['name', 'ingredients', 'steps'],
    },
  },
  ...EXTRA_TOOLS(),
];

// ── ourfamily fork: tools for everything else in the app ─────────────────────
// Executed in Trace.svelte like the ones above. Every bulk tool takes an
// array of ids and reports what worked and what failed.
function EXTRA_TOOLS() {
  const obj = (properties, required = []) => ({ type: 'object', properties, ...(required.length ? { required } : {}) });
  const ids = (what) => ({ type: 'array', items: { type: 'integer' }, description: `Ids of the ${what}.` });
  const str = (description) => ({ type: 'string', description });
  const int = (description) => ({ type: 'integer', description });
  const num = (description) => ({ type: 'number', description });
  const bool = (description) => ({ type: 'boolean', description });
  const strs = (description) => ({ type: 'array', items: { type: 'string' }, description });
  const ingredients = {
    type: 'array',
    description: 'Grouped ingredients: [{ name: "" (group name, empty for default), items: [{ qty, unit, name, note }] }]. Replaces all of them.',
    items: obj({
      name: str('Group name, empty string for the default group.'),
      items: { type: 'array', items: obj({ qty: str('Quantity'), unit: str('Unit'), name: str('Ingredient'), note: str('Prep note') }, ['name']) },
    }, ['items']),
  };
  const steps = {
    type: 'array',
    description: 'Steps: [{ title, text }]. Replaces all of them.',
    items: obj({ title: str('Optional short title'), text: str('Step text') }, ['text']),
  };
  const smart = {
    smart:             bool('true = a smart cookbook that fills itself from the filter below; false = a regular one you add recipes to.'),
    category:          str('Smart filter: recipe category name.'),
    tags:              strs('Smart filter: recipes must have every one of these tags.'),
    favorites_only:    bool('Smart filter: only favorites.'),
    min_rating:        int('Smart filter: minimum star rating 1-5.'),
    max_total_minutes: int('Smart filter: maximum prep + cook minutes.'),
  };
  return [
    // ── Recipes ──────────────────────────────────────────────────────
    {
      name: 'update_recipes',
      description: "Change one or many recipes at once. Pass every recipe id in one call (no limit) plus only the fields to change; everything else stays as it is. Use this for 'make all Main Dishes recipes Dinner' (category), 'tag these as quick', 'favorite the lasagna', 'rate it 4 stars', 'change servings to 6', 'fix step 3', renaming, notes, times, ingredients, steps. Categories belong to the account that made the recipe, so category changes only apply to the signed-in user's own recipes; others come back in skipped with the reason. A category must already exist (list_recipe_categories / create_recipe_category).",
      parameters: obj({
        recipe_ids:    ids('recipes to change'),
        name:          str('New name (only sensible for a single recipe).'),
        description:   str('New description.'),
        category:      str('Category name or id. "none" removes the category.'),
        tags:          strs('Replace all tags with this list.'),
        add_tags:      strs('Tags to add (keeps the existing ones).'),
        remove_tags:   strs('Tags to remove.'),
        tools:         strs('Replace the Kitchen Gear list.'),
        add_tools:     strs('Kitchen Gear to add.'),
        remove_tools:  strs('Kitchen Gear to remove.'),
        favorite:      bool('Favorite on or off.'),
        rating:        int('Star rating 1-5, or 0 to clear.'),
        servings:      int('Servings.'),
        yield_text:    str('Yield text, e.g. "12 cookies".'),
        prep_minutes:  int('Prep minutes.'),
        cook_minutes:  int('Cook minutes.'),
        rest_minutes:  int('Rest / rise / chill minutes.'),
        total_minutes: int('Manual total minutes override (0 = automatic).'),
        ingredients,
        steps,
        notes:         str('Author notes.'),
        source_url:    str('Source URL.'),
        video_url:     str('Video URL.'),
      }, ['recipe_ids']),
    },
    {
      name: 'delete_recipes',
      description: 'Delete one or many recipes (they go to the trash). Only when the user clearly asks to delete them.',
      parameters: obj({ recipe_ids: ids('recipes to delete') }, ['recipe_ids']),
    },
    {
      name: 'set_recipes_hidden',
      description: "Hide recipes from the rest of the family (only the owner still sees them) or unhide them. Only works on the signed-in user's own recipes.",
      parameters: obj({ recipe_ids: ids('recipes'), hidden: bool('true = hide, false = show to everyone') }, ['recipe_ids', 'hidden']),
    },
    {
      name: 'import_recipe_from_text',
      description: 'Save a recipe from pasted text (a recipe the user copied from somewhere). The server parses name, ingredients and steps. For a URL use import_recipe_from_url; for a recipe you are writing yourself use create_recipe.',
      parameters: obj({
        text:          str('The recipe text.'),
        add_to_pantry: bool('Auto-create pantry rows for new ingredient names. Default true.'),
        apply_tags:    bool('Keep tags found in the text. Default false.'),
      }, ['text']),
    },
    {
      name: 'get_recipe_versions',
      description: "List a recipe's earlier versions (copies kept when it was edited elsewhere or replaced), newest first, with who edited and when.",
      parameters: obj({ recipe_id: int('Recipe id') }, ['recipe_id']),
    },
    {
      name: 'restore_recipe_version',
      description: 'Put an earlier version of a recipe back. The current copy is kept as a version too.',
      parameters: obj({ recipe_id: int('Recipe id'), version_id: int('Version id from get_recipe_versions') }, ['recipe_id', 'version_id']),
    },
    {
      name: 'recipe_share_link',
      description: 'Make a public link to a recipe that anyone can open without an account, or turn it off.',
      parameters: obj({ recipe_id: int('Recipe id'), off: bool('true = turn the public link off') }, ['recipe_id']),
    },
    {
      name: 'get_recipe_comments',
      description: "Read the comments on a recipe (id, author, text, parent_id for replies, when).",
      parameters: obj({ recipe_id: int('Recipe id') }, ['recipe_id']),
    },
    {
      name: 'add_recipe_comment',
      description: 'Post a comment on a recipe as the signed-in user, or reply to one.',
      parameters: obj({ recipe_id: int('Recipe id'), text: str('Comment text'), reply_to: int('Optional comment id to reply to') }, ['recipe_id', 'text']),
    },
    {
      name: 'edit_recipe_comment',
      description: 'Change the text of a comment.',
      parameters: obj({ recipe_id: int('Recipe id'), comment_id: int('Comment id'), text: str('New text') }, ['recipe_id', 'comment_id', 'text']),
    },
    {
      name: 'delete_recipe_comment',
      description: 'Delete a comment.',
      parameters: obj({ recipe_id: int('Recipe id'), comment_id: int('Comment id') }, ['recipe_id', 'comment_id']),
    },

    // ── Recipe categories, tags, Kitchen Gear ────────────────────────
    {
      name: 'create_recipe_category',
      description: "Add a recipe category to the signed-in user's list (e.g. 'Dinner').",
      parameters: obj({ name: str('Category name'), color: str('Optional hex color like #e67e22') }, ['name']),
    },
    {
      name: 'update_recipe_category',
      description: 'Rename a recipe category or change its color. Every recipe in it follows.',
      parameters: obj({ category: str('Current category name or id'), name: str('New name'), color: str('New hex color, or "" to clear') }, ['category']),
    },
    {
      name: 'delete_recipe_category',
      description: 'Delete a recipe category. Its recipes stay, with no category.',
      parameters: obj({ category: str('Category name or id') }, ['category']),
    },
    {
      name: 'reorder_recipe_categories',
      description: 'Set the order recipe categories show in (the chip row on the Recipes page). Pass every category name in the new order.',
      parameters: obj({ categories: strs('Category names or ids, in order') }, ['categories']),
    },
    {
      name: 'list_tags',
      description: "List every tag used on the signed-in user's recipes, with how many recipes use each.",
      parameters: obj({}),
    },
    {
      name: 'rename_tag',
      description: "Rename a tag on every one of the signed-in user's recipes (also merges two tags: rename one to the other).",
      parameters: obj({ tag: str('Current tag'), new_name: str('New tag') }, ['tag', 'new_name']),
    },
    {
      name: 'delete_tag',
      description: "Remove a tag from every one of the signed-in user's recipes.",
      parameters: obj({ tag: str('Tag') }, ['tag']),
    },
    {
      name: 'list_kitchen_gear',
      description: "List every Kitchen Gear item (tools like 'Dutch oven') used on the signed-in user's recipes, with counts.",
      parameters: obj({}),
    },
    {
      name: 'rename_kitchen_gear',
      description: "Rename a Kitchen Gear item on every one of the signed-in user's recipes.",
      parameters: obj({ gear: str('Current name'), new_name: str('New name') }, ['gear', 'new_name']),
    },
    {
      name: 'delete_kitchen_gear',
      description: "Remove a Kitchen Gear item from every one of the signed-in user's recipes.",
      parameters: obj({ gear: str('Name') }, ['gear']),
    },

    // ── Pantry ───────────────────────────────────────────────────────
    {
      name: 'update_pantry_item',
      description: 'Change a pantry item: name, brand, quantity, unit, expiry, category, notes, barcode, serving size, in stock. Only pass what changes.',
      parameters: obj({
        pantry_id:    int('Pantry item id (from get_pantry)'),
        name:         str('Name'),
        brand:        str('Brand'),
        quantity:     num('Quantity (null clears)'),
        unit:         str('Unit'),
        expires_on:   str('Expiry date YYYY-MM-DD, or "" to clear'),
        category:     str('Pantry category name or id, or "none"'),
        notes:        str('Notes'),
        barcode:      str('Barcode'),
        in_stock:     bool('In stock'),
        serving_size: num('Serving size'),
        serving_unit: str('Serving unit (g, ml, ...)'),
      }, ['pantry_id']),
    },
    {
      name: 'delete_pantry_items',
      description: 'Delete pantry items. Only when the user clearly asks. Recipes that used them lose the pantry link but keep the ingredient text.',
      parameters: obj({ pantry_ids: ids('pantry items') }, ['pantry_ids']),
    },
    {
      name: 'get_pantry_item_recipes',
      description: 'List the recipes that use a pantry item.',
      parameters: obj({ pantry_id: int('Pantry item id') }, ['pantry_id']),
    },
    {
      name: 'create_pantry_category',
      description: 'Add a pantry category (e.g. "Frozen").',
      parameters: obj({ name: str('Name'), icon: str('Optional Material Symbols icon name'), color: str('Optional hex color'), default_aisle: str('Optional shopping aisle for items in it') }, ['name']),
    },
    {
      name: 'update_pantry_category',
      description: 'Rename a pantry category or change its icon, color or default aisle.',
      parameters: obj({ category: str('Current name or id'), name: str('New name'), icon: str('Icon'), color: str('Hex color'), default_aisle: str('Default aisle') }, ['category']),
    },
    {
      name: 'delete_pantry_category',
      description: 'Delete a pantry category. Its items stay, uncategorized.',
      parameters: obj({ category: str('Name or id') }, ['category']),
    },
    {
      name: 'list_units',
      description: 'List custom measurement units, the built-in units that are turned off, and how often each unit is used in recipes.',
      parameters: obj({}),
    },
    {
      name: 'add_custom_unit',
      description: 'Add a custom measurement unit (e.g. abbr "stk", full name "stick").',
      parameters: obj({ abbr: str('Abbreviation'), full_name: str('Full name'), category: str('Optional: volume, weight, count, ...') }, ['abbr']),
    },
    {
      name: 'delete_custom_unit',
      description: 'Delete a custom unit.',
      parameters: obj({ unit: str('Abbreviation or id') }, ['unit']),
    },
    {
      name: 'set_builtin_unit_enabled',
      description: 'Turn a built-in unit (like "dash" or "pinch") on or off in the unit pickers.',
      parameters: obj({ abbr: str('Built-in unit abbreviation'), enabled: bool('true = on, false = off') }, ['abbr', 'enabled']),
    },

    // ── Shopping list ────────────────────────────────────────────────
    {
      name: 'update_shopping_item',
      description: 'Change a shopping list item: name, quantity, unit, aisle, checked.',
      parameters: obj({ item_id: int('Shopping item id'), name: str('Name'), quantity: num('Quantity'), unit: str('Unit'), aisle: str('Aisle'), checked: bool('Checked off') }, ['item_id']),
    },
    {
      name: 'check_shopping_items',
      description: "Check off (or uncheck) shopping list items. Use for 'I got the milk and eggs'.",
      parameters: obj({ item_ids: ids('shopping items'), checked: bool('true = checked, false = unchecked. Default true.') }, ['item_ids']),
    },
    {
      name: 'remove_shopping_items',
      description: 'Remove items from the shopping list.',
      parameters: obj({ item_ids: ids('shopping items') }, ['item_ids']),
    },
    {
      name: 'clear_checked_shopping',
      description: 'Remove every checked-off item from the shopping list.',
      parameters: obj({}),
    },
    {
      name: 'clear_shopping_for_recipe',
      description: 'Remove every shopping list item that was added from a given recipe.',
      parameters: obj({ recipe_id: int('Recipe id') }, ['recipe_id']),
    },
    {
      name: 'shop_for_recipe',
      description: "Add a recipe's ingredients to the shopping list. By default only what isn't in stock.",
      parameters: obj({ recipe_id: int('Recipe id'), only_missing: bool('Default true. false = add every ingredient.') }, ['recipe_id']),
    },
    {
      name: 'shop_for_plan',
      description: 'Add the ingredients of every planned cook in a date range to the shopping list (the meal plan). By default only what is not in stock.',
      parameters: obj({ from: str('Start YYYY-MM-DD'), to: str('End YYYY-MM-DD'), only_missing: bool('Default true') }, ['from', 'to']),
    },

    // ── Cook diary ───────────────────────────────────────────────────
    {
      name: 'update_diary_entry',
      description: "Change a diary entry: date, kind ('cooked' or 'planned'; planned → cooked marks a plan as done), meal_type, rating, servings, notes. Get ids from get_diary.",
      parameters: obj({
        entry_id:  int('Diary entry id'),
        date:      str('YYYY-MM-DD'),
        kind:      str("'cooked' or 'planned'"),
        meal_type: str("'breakfast' | 'lunch' | 'dinner' | 'snack', or '' to clear"),
        rating:    int('1-5 for this cook, 0 to clear'),
        servings:  num('Servings'),
        notes:     str('Notes'),
      }, ['entry_id']),
    },
    {
      name: 'delete_diary_entries',
      description: "Delete cook diary entries (cooked or planned). Use to undo a cook logged by mistake. Cook counts update by themselves.",
      parameters: obj({ entry_ids: ids('diary entries') }, ['entry_ids']),
    },
    {
      name: 'get_cook_stats',
      description: 'Cooking stats: cooks this week / month / total, most-cooked recipe this month, current and longest streak.',
      parameters: obj({}),
    },

    // ── Cookbooks ────────────────────────────────────────────────────
    {
      name: 'create_cookbook',
      description: 'Make a cookbook. Regular cookbooks hold recipes you add (add_to_cookbook); smart ones fill themselves from a filter.',
      parameters: obj({ name: str('Name'), description: str('Optional description'), ...smart }, ['name']),
    },
    {
      name: 'update_cookbook',
      description: "Rename a cookbook, change its description, or change / turn on / turn off its smart filter.",
      parameters: obj({ cookbook_id: int('Cookbook id'), name: str('New name'), description: str('New description'), ...smart }, ['cookbook_id']),
    },
    {
      name: 'delete_cookbook',
      description: 'Delete a cookbook. The recipes in it are not deleted.',
      parameters: obj({ cookbook_id: int('Cookbook id') }, ['cookbook_id']),
    },
    {
      name: 'remove_from_cookbook',
      description: 'Take recipes out of a regular cookbook (the recipes themselves stay).',
      parameters: obj({ cookbook_id: int('Cookbook id'), recipe_ids: ids('recipes') }, ['cookbook_id', 'recipe_ids']),
    },

    // ── Households ───────────────────────────────────────────────────
    {
      name: 'list_people',
      description: 'List the accounts in the family (id and name), for adding people to households.',
      parameters: obj({}),
    },
    {
      name: 'create_household',
      description: 'Start a new household.',
      parameters: obj({ name: str('Name'), join_policy: str("'open' (anyone can join) or 'invite'"), guests: bool('Whether guests can use it. Default true.') }, ['name']),
    },
    {
      name: 'update_household',
      description: "Rename a household or change who can join it (owner or admin only).",
      parameters: obj({ household: str('Household name or id'), name: str('New name'), join_policy: str("'open' or 'invite'"), guests: bool('Guests can use it') }, ['household']),
    },
    {
      name: 'delete_household',
      description: 'Delete a household (owner or admin only). Its recipes are not deleted.',
      parameters: obj({ household: str('Household name or id') }, ['household']),
    },
    {
      name: 'join_household',
      description: 'Join a household as the signed-in user.',
      parameters: obj({ household: str('Household name or id') }, ['household']),
    },
    {
      name: 'leave_household',
      description: 'Leave a household as the signed-in user.',
      parameters: obj({ household: str('Household name or id') }, ['household']),
    },
    {
      name: 'add_household_member',
      description: 'Add a person to a household (owner or admin only).',
      parameters: obj({ household: str('Household name or id'), person: str('Person name or id (list_people)') }, ['household', 'person']),
    },
    {
      name: 'remove_household_member',
      description: 'Remove a person from a household.',
      parameters: obj({ household: str('Household name or id'), person: str('Person name or id') }, ['household', 'person']),
    },
    {
      name: 'set_household_owner',
      description: 'Make another member the owner of a household.',
      parameters: obj({ household: str('Household name or id'), person: str('Person name or id') }, ['household', 'person']),
    },
  ];
}

// ── Main entry point ────────────────────────────────────────────────────────

export async function callAI({ provider, apiKey, model, messages, systemPrompt, tools, onToolCall, onToolResult, baseUrl }) {
  // 'custom' is the legacy CookTrace name for the same OpenAI-compatible
  // path that NutriTrace calls 'oai-compat'. Both are accepted.
  if (!apiKey && provider !== 'custom' && provider !== 'oai-compat') {
    throw new Error('No API key configured. Add one in Settings → Trace Assistant.');
  }
  const cb = { onToolCall, onToolResult };
  switch (provider) {
    case 'claude':     return _callClaudeWithTools(apiKey, model, messages, systemPrompt, tools, cb);
    case 'openai':     return _callOpenAIWithTools(apiKey, model, messages, systemPrompt, tools, cb, 'https://api.openai.com');
    case 'gemini':     return _callGeminiWithTools(apiKey, model, messages, systemPrompt, tools, cb);
    case 'oai-compat':
    case 'custom': {
      if (!baseUrl) throw new Error('OpenAI-compatible provider needs a Base URL. Set one in Settings → Trace.');
      if (!model)   throw new Error('OpenAI-compatible provider needs a model name. Set one in Settings → Trace.');
      return _callOpenAIWithTools(apiKey || 'no-key', model, messages, systemPrompt, tools, cb, baseUrl.replace(/\/+$/, ''));
    }
    default: throw new Error(`Unknown AI provider: ${provider}`);
  }
}

/** Server-proxy fallback for env-locked installs. Text-only — tools
 *  aren't relayed because the server can't execute client-side. */
export async function callAIProxy({ messages, systemPrompt }) {
  const { apiUrl, isNative, getServerUrl, getAuthToken } = await import('./platform.js');
  const headers = { 'Content-Type': 'application/json' };
  if (isNative && getServerUrl()) {
    // Native server mode: cookies don't survive WebView reloads, fall back
    // to the same Bearer token api.js uses. Without this, env-locked AI
    // calls return 401 from /api/ai/chat on Android.
    const token = getAuthToken();
    if (token) headers['Authorization'] = `Bearer ${token}`;
  } else {
    const csrf = typeof localStorage !== 'undefined' ? localStorage.getItem('ct:csrf') : null;
    if (csrf) headers['X-CSRF-Token'] = csrf;
  }
  const res = await fetch(apiUrl('/api/ai/chat'), {
    method: 'POST',
    credentials: 'include',
    headers,
    body: JSON.stringify({ messages, systemPrompt }),
  });
  const data = await res.json().catch(() => ({}));
  if (!res.ok) {
    if (res.status === 401) throw new Error('Not signed in — sign in again to use AI features.');
    throw new Error(data.error || `AI proxy error ${res.status}`);
  }
  return data.text || data.content || data.message || (data.choices?.[0]?.message?.content) || '';
}

// ── Anthropic Claude (with tool use) ────────────────────────────────────────
async function _callClaudeWithTools(apiKey, model, messages, systemPrompt, tools, cb) {
  const { onToolCall, onToolResult } = cb || {};
  const claudeTools = (tools || []).map(t => ({
    name: t.name,
    description: t.description,
    input_schema: t.parameters,
  }));
  let currentMessages = [...messages];

  // ourfamily fork: no round cap; keep going until the model stops calling tools.
  for (;;) {
    const body = {
      model: model || AI_DEFAULT_MODELS.claude,
      max_tokens: 4096,
      system: systemPrompt,
      messages: currentMessages,
    };
    if (claudeTools.length) body.tools = claudeTools;
    const res = await fetch('https://api.anthropic.com/v1/messages', {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        'x-api-key': apiKey,
        'anthropic-version': '2023-06-01',
        'anthropic-dangerous-direct-browser-access': 'true',
      },
      body: JSON.stringify(body),
    });
    const data = await res.json();
    if (!res.ok) throw new Error(data.error?.message || `Claude API error ${res.status}`);

    const toolUses = (data.content || []).filter(b => b.type === 'tool_use');
    const textBlocks = (data.content || []).filter(b => b.type === 'text');
    if (toolUses.length === 0 || data.stop_reason !== 'tool_use') {
      return textBlocks.map(b => b.text).join('\n') || '';
    }
    currentMessages.push({ role: 'assistant', content: data.content });
    const toolResults = [];
    for (const tu of toolUses) {
      if (onToolCall) onToolCall(tu.name, tu.input);
      const result = await _executeTool(tu.name, tu.input);
      if (onToolResult) onToolResult(tu.name, result);
      toolResults.push({ type: 'tool_result', tool_use_id: tu.id, content: JSON.stringify(result) });
    }
    currentMessages.push({ role: 'user', content: toolResults });
  }
}

// ── OpenAI / OpenAI-compatible ─────────────────────────────────────────────
async function _callOpenAIWithTools(apiKey, model, messages, systemPrompt, tools, cb, baseUrl = 'https://api.openai.com') {
  const { onToolCall, onToolResult } = cb || {};
  const openaiTools = (tools || []).map(t => ({
    type: 'function',
    function: { name: t.name, description: t.description, parameters: t.parameters },
  }));
  let currentMessages = [
    { role: 'system', content: systemPrompt },
    ...messages,
  ];

  // ourfamily fork: no round cap; keep going until the model stops calling tools.
  for (;;) {
    const selectedModel = model || AI_DEFAULT_MODELS.openai;
    const body = {
      model: selectedModel,
      messages: currentMessages,
      ...getOpenAIChatParams({
        baseUrl,
        model: selectedModel,
        hasTools: openaiTools.length > 0,
      }),
    };
    if (openaiTools.length) body.tools = openaiTools;
    const headers = { 'Content-Type': 'application/json', 'Accept': 'application/json' };
    if (apiKey && apiKey !== 'no-key') headers['Authorization'] = `Bearer ${apiKey}`;
    const res = await fetch(`${baseUrl}/v1/chat/completions`, {
      method: 'POST',
      headers,
      body: JSON.stringify(body),
    });
    const data = await res.json();
    if (!res.ok) throw new Error(data.error?.message || `AI API error ${res.status}`);

    const choice = data.choices[0];
    const msg = choice.message;
    if (!msg.tool_calls || msg.tool_calls.length === 0) {
      return msg.content || '';
    }
    currentMessages.push(msg);
    for (const tc of msg.tool_calls) {
      if (onToolCall) onToolCall(tc.function.name, JSON.parse(tc.function.arguments || '{}'));
      const args = JSON.parse(tc.function.arguments || '{}');
      const result = await _executeTool(tc.function.name, args);
      if (onToolResult) onToolResult(tc.function.name, result);
      currentMessages.push({ role: 'tool', tool_call_id: tc.id, content: JSON.stringify(result) });
    }
  }
}

// ── Google Gemini ──────────────────────────────────────────────────────────
// Models Google has shut down or scheduled for shutdown. Saved selections
// pointing at any of these are quietly remapped to the current default so
// users who never opened Settings after a bump don't suddenly hit 404s.
const GEMINI_RETIRED = new Set([
  'gemini-1.5-flash', 'gemini-1.5-pro',
  'gemini-2.0-flash', 'gemini-2.0-flash-lite',
]);

async function _callGeminiWithTools(apiKey, model, messages, systemPrompt, tools, cb) {
  const { onToolCall, onToolResult } = cb || {};
  let m = model || AI_DEFAULT_MODELS.gemini;
  if (GEMINI_RETIRED.has(m)) m = AI_DEFAULT_MODELS.gemini;
  const url = `https://generativelanguage.googleapis.com/v1beta/models/${m}:generateContent?key=${apiKey}`;
  const geminiTools = (tools || []).length ? [{
    functionDeclarations: tools.map(t => ({
      name: t.name,
      description: t.description,
      parameters: t.parameters,
    })),
  }] : undefined;

  let contents = messages.map(msg => {
    const parts = [];
    if (msg._image) {
      parts.push({ inlineData: { mimeType: msg._image.mimeType, data: msg._image.base64 } });
    }
    parts.push({ text: typeof msg.content === 'string' ? msg.content : (msg.content || '') });
    return { role: msg.role === 'assistant' ? 'model' : 'user', parts };
  });

  // ourfamily fork: no round cap; keep going until the model stops calling tools.
  for (;;) {
    const body = {
      systemInstruction: { parts: [{ text: systemPrompt }] },
      contents,
    };
    if (geminiTools) body.tools = geminiTools;
    const res = await fetch(url, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(body),
    });
    const data = await res.json();
    if (!res.ok) throw new Error(data.error?.message || `Gemini API error ${res.status}`);
    const candidate = data.candidates?.[0];
    const parts = candidate?.content?.parts || [];
    const functionCalls = parts.filter(p => p.functionCall);
    const textParts = parts.filter(p => p.text);
    if (functionCalls.length === 0) {
      return textParts.map(p => p.text).join('\n') || '';
    }
    contents.push({ role: 'model', parts });
    const responseParts = [];
    for (const fc of functionCalls) {
      if (onToolCall) onToolCall(fc.functionCall.name, fc.functionCall.args || {});
      const result = await _executeTool(fc.functionCall.name, fc.functionCall.args || {});
      if (onToolResult) onToolResult(fc.functionCall.name, result);
      responseParts.push({ functionResponse: { name: fc.functionCall.name, response: result } });
    }
    contents.push({ role: 'user', parts: responseParts });
  }
}

// ── Tool execution ──────────────────────────────────────────────────────────
let _toolHandler = null;
export function setToolHandler(handler) { _toolHandler = handler; }

async function _executeTool(name, args) {
  if (!_toolHandler) return { error: 'Tool handler not registered' };
  try {
    return await _toolHandler(name, args);
  } catch (e) {
    return { error: e.message || 'Tool execution failed' };
  }
}
