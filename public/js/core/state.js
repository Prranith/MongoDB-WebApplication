// ═══════════════════════════════════════════════════════════════════
// CONSTANTS & CONFIGS
// ═══════════════════════════════════════════════════════════════════
const _TYPE_ICONS = {
  "object":   "<span style='color:#c084fc;font-weight:700'>{}</span>",
  "array":    "<span style='color:#c084fc;font-weight:700'>[]</span>",
  "string":   "<span style='color:#c084fc;font-weight:700'>\"a\"</span>",
  "number":   "<span style='color:#c084fc;font-weight:700'>123</span>",
  "boolean":  "<span style='color:#c084fc;font-weight:700'>T/F</span>",
  "null":     "<span style='color:#a1a1aa;font-weight:700'>nil</span>",
  "date":     "<span style='background:#6b21a8;color:#ffffff;padding:1px 5px;border-radius:2px;font-size:10px;font-weight:700'>D</span>",
  "objectid": "<span style='background:#6b21a8;color:#ffffff;padding:1px 5px;border-radius:2px;font-size:10px;font-weight:700'>D</span>",
  "unknown":  "<span style='color:#a1a1aa'>?</span>",
};

const _TYPE_COLORS = {
  "string":   "#ce9178",
  "number":   "#b5cea8",
  "boolean":  "#569cd6",
  "null":     "#858585",
  "date":     "#4ec9b0",
  "objectid": "#4ec9b0",
  "object":   "#858585",
  "array":    "#c586c0",
};

const COLL_ICONS = {
  users: '👤',
  orders: '📦',
  inventory: '🏭',
  shipments: '🚚',
  elite: '⭐'
};

const RELATIONS = {
  orders: [
    { field: "userId", type: "Many-to-One", to: "users.userId", desc: "Links the order to the customer profile who placed it." },
    { field: "items[].sku", type: "Many-to-One", to: "inventory.sku", desc: "Links each ordered item to its inventory stock profile." }
  ],
  shipments: [
    { field: "orderId", type: "One-to-One", to: "orders.orderId", desc: "Links the shipment details to the specific order being delivered." }
  ],
  users: [
    { field: "userId", type: "One-to-Many", to: "orders.userId", desc: "Bridges customer profiles to all orders they have placed." }
  ],
  inventory: [
    { field: "sku", type: "One-to-Many", to: "orders.items.sku", desc: "Maps product sku to line items ordered across the system." }
  ],
  elite: [
    { field: "userId", type: "Many-to-One", to: "users.userId", desc: "Links elite transaction to customer profile." }
  ]
};

// ═══════════════════════════════════════════════════════════════════
// GLOBAL STATE
// ═══════════════════════════════════════════════════════════════════
const S = {
  view: 'intro',
  sidePanel: 'explorer',
  sidebarOpen: false,
  inspectorOpen: true,
  activeCollection: 'users',
  collections: [],
  snippets: {},
  conTab: 'output',
  resultView: 'tree',
  lastData: null,
  lastRaw: '',
  files: [], // { name, path, content, type: 'file'/'folder' }
  activeFile: null, // path of currently open file
  tabs: [], // paths of open files
  history: [], // query runs
  dbRootOpen: true,
  filesOpen: true,
  outlineOpen: false,
  timelineOpen: false,
  settings: {},
};

let editor;
