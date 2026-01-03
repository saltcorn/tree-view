/*jshint esversion: 8 */

const Field = require("@saltcorn/data/models/field");
const Table = require("@saltcorn/data/models/table");
const Form = require("@saltcorn/data/models/form");
const View = require("@saltcorn/data/models/view");
const {
  eval_expression,
  jsexprToWhere,
} = require("@saltcorn/data/models/expression");
const Workflow = require("@saltcorn/data/models/workflow");
const FieldRepeat = require("@saltcorn/data/models/fieldrepeat");

const { runInNewContext } = require("vm");

const {
  stateFieldsToWhere,
  readState,
  picked_fields_to_query,
} = require("@saltcorn/data/plugin-helper");
const { mergeIntoWhere } = require("@saltcorn/data/utils");
const {
  text,
  div,
  h3,
  style,
  a,
  script,
  pre,
  domReady,
  i,
} = require("@saltcorn/markup/tags");

const { features, getState } = require("@saltcorn/data/db/state");
const db = require("@saltcorn/data/db");
const public_user_role = features?.public_user_role || 10;

const headers = [
  {
    script: `/plugins/public/tree-view@${
      require("./package.json").version
    }/js/gijgo.min.js`,
    onlyViews: ["TreeView"],
  },
  {
    css: `/plugins/public/tree-view@${
      require("./package.json").version
    }/js/gijgo.min.css`,
    onlyViews: ["TreeView"],
  },
];

const get_state_fields = async (table_id, viewname, { show_view }) => {
  const table = Table.findOne(table_id);
  const table_fields = table.fields;
  return table_fields
    .filter((f) => !f.primary_key)
    .map((f) => {
      const sf = new Field(f);
      sf.required = false;
      return sf;
    });
};

const configuration_workflow = () =>
  new Workflow({
    steps: [
      {
        name: "Views and fields",
        form: async (context) => {
          const table = await Table.findOne({ id: context.table_id });
          const fields = table.fields;

          const order_options = fields.filter((f) =>
            ["Integer", "Float", "String"].includes(f.type?.name)
          );

          return new Form({
            fields: [
              {
                name: "title_field",
                label: "Title field",
                type: "String",
                sublabel: "Event label displayed on the task.",
                required: true,
                attributes: {
                  options: fields
                    .filter((f) => f.type.name === "String")
                    .map((f) => f.name),
                },
              },
              {
                name: "parent_field",
                label: "Parent field",
                type: "String",
                required: true,
                attributes: {
                  options: fields
                    .filter((f) => f.reftable_name === table.name)
                    .map((f) => f.name),
                },
              },
              {
                name: "order_field",
                label: "Order field",
                type: "String",
                sublabel: "Optional. An Integer field",
                attributes: {
                  options: order_options,
                },
              },
              {
                name: "include_fml",
                label: "Row inclusion formula",
                class: "validate-expression",
                sublabel:
                  "Only include rows where this formula is true. " +
                  "In scope:" +
                  " " +
                  [
                    ...table.fields.map((f) => f.name),
                    "user",
                    "year",
                    "month",
                    "day",
                    "today()",
                  ]
                    .map((s) => `<code>${s}</code>`)
                    .join(", "),
                type: "String",
                help: {
                  topic: "Inclusion Formula",
                  context: { table_name: table.name },
                },
              },
              {
                name: "filtering",
                label: "Filtering",
                type: "Bool",
                sublabel: "Selecting a node sets state filter",
              },
              {
                name: "drag_and_drop",
                label: "Drag and drop",
                type: "Bool",
              },
              {
                name: "expand_all",
                label: "Expand all",
                type: "Bool",
              },
            ],
          });
        },
      },
    ],
  });

const run = async (
  table_id,
  viewname,
  {
    title_field,
    parent_field,
    include_fml,
    order_field,
    drag_and_drop,
    expanded_max_level,
    filtering,
    expand_all,
  },
  state,
  extraArgs
) => {
  const table = await Table.findOne({ id: table_id });
  const fields = table.fields;
  const pk_name = table.pk_name;
  readState(state, fields);
  const where = await stateFieldsToWhere({ fields, state, table });
  const joinFields = {};
  const order_fld = fields.find((f) => f.name === order_field);
  const unique_field = fields.find(
    (f) => (f.is_unique || f.primary_key) && state[f.name]
  );
  const whereNoId = { ...where };
  delete whereNoId[pk_name];
  /*if (unique_field) {
    //https://dba.stackexchange.com/questions/175868/cte-get-all-parents-and-all-children-in-one-statement
    const schema = db.getTenantSchemaPrefix();
    const ufname = db.sqlsanitize(unique_field.name);
    const pkname = db.sqlsanitize(table.pk_name);
    const ispk = ufname === pkname;
    const q = `WITH RECURSIVE rec_d (${ufname}) as (
    SELECT t.${ufname}${ispk ? "" : `, t.${pkname}`} FROM ${schema}"${
      table.name
    }" t WHERE ${ufname} = $1
    UNION ALL
    SELECT t.${ufname}${ispk ? "" : `, t.${pkname}`} FROM rec_d, ${schema}"${
      table.name
    }" t where t.${db.sqlsanitize(parent_field)} = rec_d.${pkname}
      ) SELECT ${ufname} FROM rec_d`;
    const idres = await db.query(
      q,

      [state[unique_field.name]]
    );
    where[unique_field.name] = { in: idres.rows.map((r) => r[ufname]) };
  }*/
  if (include_fml) {
    let where1 = jsexprToWhere(include_fml, {}, fields);
    mergeIntoWhere(whereNoId, where1 || {});
  }

  const rows = await table.getJoinedRows({
    where: whereNoId,
    orderBy: order_field || undefined,
    nocase: order_fld?.type?.name === "String" ? true : undefined,
    forUser: extraArgs.req.user || { role_id: public_user_role },
    forPublic: !extraArgs.req.user,
  });

  const rndid = Math.floor(Math.random() * 16777215).toString(16);
  const rowToData = (row, level = 0) => {
    const childRows = rows.filter((r) => r[parent_field] === row[pk_name]);
    const node = {
      text: row[title_field],
      [pk_name]: row[pk_name],
      checked: false,
      hasChildren: false,
      children: childRows.map((r) => rowToData(r, level + 1)),
    };
    if (
      typeof expanded_max_level === "number" &&
      level > expanded_max_level - 1
    )
      node.expanded = false;

    return node;
  };
  let nodeData;
  let setRootForNewNodes = "";

  const roots = rows.filter((r) => !r[parent_field]);
  nodeData = roots.map((r) => rowToData(r));
  const isDark = extraArgs.req?.user?.lightDarkMode === "dark";
  let bgDark;
  if (isDark) {
    const layout = getState().getLayout(extraArgs.req?.user);
    bgDark = layout?.config?.backgroundColorDark;
  }

  return div(
    div({ id: `treeview${rndid}` }),
    style(`.gj-list .list-group-item {
    background-color: #fff;    
}`),
    isDark &&
      style(`
      #treeview${rndid} .gj-list .list-group-item {
        background-color: ${bgDark || "#222"};
      }
      #treeview${rndid} .gj-list .list-group-item.active {
        background-color: #0d6efd;
      }
      #treeview${rndid} .list-group-item.active ul li, #treeview${rndid} .list-group-item.active:focus ul li, #treeview${rndid} .list-group-item.active:hover ul li {
        color: unset
      }
      `),
    script(
      domReady(`
    const selected_id = ${JSON.stringify(state[pk_name])}
    const tree = $('#treeview${rndid}').tree({
                    uiLibrary: 'bootstrap5',
                    dataSource: ${JSON.stringify(nodeData)},
                    primaryKey: '${pk_name}',
                    selectionType: 'single',
                    cascadeSelection: false,
                    dragAndDrop: ${JSON.stringify(drag_and_drop)}
                });
    ${
      filtering
        ? `tree.on('select', function (e, node, id) {
    if(id!=selected_id)
       set_state_field('${pk_name}',id)
      })`
        : ""
    }
    ${
      drag_and_drop
        ? `tree.on('nodeDrop', function (e, id, parentId, orderNumber) {
           var params = { id: id, parent_id: parentId, order_number: orderNumber };     
           view_post('${viewname}', 'drag_drop', params);                                      
        });`
        : ""
    }
    ${
      state[pk_name] && filtering
        ? `
      const selnode = $("li[data-id=${state[pk_name]}]")
      tree.select(selnode);
      tree.expand(selnode);
      selnode.parents("li[data-id]").each(function() {tree.expand($(this))})`
        : ""
    }
    ${
      expand_all
        ? `      
      $("li[data-id]").each(function() {tree.expand($(this))})`
        : ""
    }
    `)
    )
  );
};

const drag_drop = async (
  table_id,
  viewname,
  { title_field, parent_field, read_only, order_field },
  { id, order_number, parent_id },
  { req }
) => {
  if (read_only) return { json: { error: "Read only mode" } };
  const table = await Table.findOne({ id: table_id });

  const role = req.isAuthenticated() ? req.user.role_id : public_user_role;
  if (
    role > table.min_role_write &&
    !(table.ownership_field || table.ownership_formula)
  ) {
    return { json: { error: "not authorized" } };
  }
  const updRow = {};
  //if (topic) updRow[title_field] = topic;
  if (id && typeof parent_id === "undefined" && parent_field)
    updRow[parent_field] = null;
  else if (parent_id) updRow[parent_field] = parent_id;
  const order_fld = table.getField(order_field);
  if (
    id &&
    order_number &&
    order_field &&
    order_field !== table.pk_name &&
    order_fld?.type?.name === "Integer"
  )
    updRow[order_field] = +order_number;

  await table.updateRow(updRow, id, req.user || { role_id: public_user_role });
  return { json: { success: "ok" } };
};

module.exports = {
  sc_plugin_api_version: 1,
  headers,
  plugin_name: "tree-view",
  viewtemplates: [
    {
      name: "TreeView",
      description:
        "Tree view used for editing and filtering based on Gijgo TreeView",
      display_state_form: false,
      get_state_fields,
      configuration_workflow,
      run,
      routes: { drag_drop },
    },
  ],
};
