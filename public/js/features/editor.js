// ═══════════════════════════════════════════════════════════════════
// MONGO INTELLISENSE AUTOCOMPLETION PROVIDER
// ═══════════════════════════════════════════════════════════════════
function setupMongoIntelliSense() {
  if (typeof CodeMirror === 'undefined') return;

  const COLLECTIONS_INFO = [
    { text: "users", displayText: "users — Customer profile accounts" },
    { text: "orders", displayText: "orders — System purchase orders" },
    { text: "inventory", displayText: "inventory — Product stock levels" },
    { text: "shipments", displayText: "shipments — Logistical delivery tracking" },
    { text: "elite", displayText: "elite — Premium subscriber transactions" }
  ];

  const METHODS_INFO = [
    { text: "find", displayText: "find(query) — Queries documents in collection" },
    { text: "findOne", displayText: "findOne(query) — Finds first matching document" },
    { text: "aggregate", displayText: "aggregate(pipeline) — Multi-stage aggregation" },
    { text: "countDocuments", displayText: "countDocuments(query) — Counts matching documents" },
    { text: "distinct", displayText: "distinct(field, query) — Gets unique values of a field" },
    { text: "insertOne", displayText: "insertOne(doc) — Inserts a document" },
    { text: "updateOne", displayText: "updateOne(filter, update) — Modifies a document" },
    { text: "sort", displayText: "sort(spec) — Sorts results cursor" },
    { text: "limit", displayText: "limit(num) — Restricts maximum result count" },
    { text: "skip", displayText: "skip(num) — Skips starting results" }
  ];

  const OPERATORS_INFO = [
    // Stages
    { text: "$match", displayText: "$match — Filters input documents" },
    { text: "$group", displayText: "$group — Groups documents and computes aggregates" },
    { text: "$project", displayText: "$project — Reshapes or projects document fields" },
    { text: "$sort", displayText: "$sort — Reorders document stream" },
    { text: "$limit", displayText: "$limit — Restricts stream to first N documents" },
    { text: "$skip", displayText: "$skip — Skips first N documents" },
    { text: "$lookup", displayText: "$lookup — Performs left outer join to another collection" },
    { text: "$unwind", displayText: "$unwind — Deconstructs array field into document stream" },
    { text: "$addFields", displayText: "$addFields — Adds new fields to documents" },
    { text: "$facet", displayText: "$facet — Processes multiple parallel pipelines" },
    // Aggregation/Query Operators
    { text: "$sum", displayText: "$sum — Computes sum of values" },
    { text: "$avg", displayText: "$avg — Computes average of values" },
    { text: "$min", displayText: "$min — Finds minimum value" },
    { text: "$max", displayText: "$max — Finds maximum value" },
    { text: "$gt", displayText: "$gt — Greater-than comparison operator" },
    { text: "$gte", displayText: "$gte — Greater-than-or-equal comparison" },
    { text: "$lt", displayText: "$lt — Less-than comparison operator" },
    { text: "$lte", displayText: "$lte — Less-than-or-equal comparison" },
    { text: "$in", displayText: "$in — Checks if value is in array" },
    { text: "$exists", displayText: "$exists — Matches documents with specified field" }
  ];

  const KEYWORDS_INFO = [
    { text: "db", displayText: "db — The database instance object" }
  ];

  function getCollectionsSuggestions() {
    const colls = [...COLLECTIONS_INFO];
    try {
      const custom = JSON.parse(localStorage.getItem('mongosandbox_custom_collections') || '{}');
      Object.keys(custom).forEach(name => {
        if (!colls.some(c => c.text === name)) {
          colls.push({ text: name, displayText: `${name} — Custom uploaded dataset` });
        }
      });
    } catch(e) {}
    return colls;
  }

  CodeMirror.registerHelper("hint", "javascript", function(cm) {
    const cur = cm.getCursor();
    const lineText = cm.getLine(cur.line);
    const textBefore = lineText.substring(0, cur.ch);
    
    let list = [];
    let from = cur;
    let to = cur;
    
    // Check if we are typing a collection name (right after "db." or "db.xyz")
    const dbMatch = textBefore.match(/db\.([a-zA-Z0-9_]*)$/);
    // Check if we are typing a method name (after "db.collectionName." or chaining)
    const methodMatch = textBefore.match(/(?:\.[a-zA-Z0-9_]+|[)]+)\.([a-zA-Z0-9_]*)$/);
    // Check if we are typing an operator (starting with $)
    const operatorMatch = textBefore.match(/\$([a-zA-Z0-9_]*)$/);
    // Otherwise general word matching
    const generalMatch = textBefore.match(/([a-zA-Z0-9_]+)$/);
    
    if (dbMatch) {
      const typed = dbMatch[1].toLowerCase();
      const allColls = getCollectionsSuggestions();
      list = allColls.filter(c => c.text.toLowerCase().includes(typed));
      from = CodeMirror.Pos(cur.line, cur.ch - dbMatch[1].length);
    } else if (methodMatch) {
      const typed = methodMatch[1].toLowerCase();
      list = METHODS_INFO.filter(m => m.text.toLowerCase().includes(typed));
      from = CodeMirror.Pos(cur.line, cur.ch - methodMatch[1].length);
    } else if (operatorMatch) {
      const typed = operatorMatch[1].toLowerCase();
      list = OPERATORS_INFO.filter(o => o.text.toLowerCase().includes(typed));
      from = CodeMirror.Pos(cur.line, cur.ch - operatorMatch[0].length); // replace starting from '$'
    } else if (generalMatch) {
      const typed = generalMatch[1].toLowerCase();
      list = KEYWORDS_INFO.filter(k => k.text.toLowerCase().includes(typed));
      from = CodeMirror.Pos(cur.line, cur.ch - generalMatch[1].length);
    }
    
    if (!list.length) return null;
    
    return {
      list: list.map(item => ({
        text: item.text,
        displayText: item.displayText
      })),
      from: from,
      to: to
    };
  });
}
