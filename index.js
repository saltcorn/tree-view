/*jshint esversion: 8 */

const Field = require("@saltcorn/data/models/field");
const Table = require("@saltcorn/data/models/table");
const Form = require("@saltcorn/data/models/form");
const View = require("@saltcorn/data/models/view");
const { eval_expression } = require("@saltcorn/data/models/expression");
const Workflow = require("@saltcorn/data/models/workflow");
const FieldRepeat = require("@saltcorn/data/models/fieldrepeat");

const { runInNewContext } = require("vm");

const {
  stateFieldsToWhere,
  readState,
  picked_fields_to_query,
} = require("@saltcorn/data/plugin-helper");

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
            ["Integer", "Float", "Date", "String"].includes(f.type?.name)
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
                attributes: {
                  options: order_options,
                },
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
    color_field,
    text_color_field,
    edit_view,
    direction,
    root_relation_field,
    view_height,
    view_height_units,
    annotations,
    link_style,
    order_field,
    node_gap_h,
    node_gap_v,
    expander_visible,
    newline_tags,
    set_tag_color,
    tag_text_color,
    tag_bg_color,
    set_palette,
    palette,
    expanded_max_level,
    read_only,
    link_icon,
  },
  state,
  extraArgs
) => {
  const table = await Table.findOne({ id: table_id });
  const fields = table.fields;
  readState(state, fields);
  const where = await stateFieldsToWhere({ fields, state, table });
  const joinFields = {};
  const order_fld = fields.find((f) => f.name === order_field);
  const unique_field = fields.find(
    (f) => (f.is_unique || f.primary_key) && state[f.name]
  );
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

  const rows = await table.getJoinedRows({
    //where,
    orderBy: order_field || undefined,
    nocase: order_fld?.type?.name === "String" ? true : undefined,
  });

  const rndid = Math.floor(Math.random() * 16777215).toString(16);
  const pk_name = table.pk_name;
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

  return div(
    div({ id: `treeview${rndid}` }),
    style(`.gj-list .list-group-item {
    background-color: #fff;    
}` ),
    script(
      domReady(`
    const selected_id = ${JSON.stringify(state[pk_name])}
    const tree = $('#treeview${rndid}').tree({
                    uiLibrary: 'bootstrap5',
                    dataSource: ${JSON.stringify(nodeData)},
                    primaryKey: '${pk_name}',
                    selectionType: 'single',
                    cascadeSelection: false
                });
    tree.on('select', function (e, node, id) {
    if(id!=selected_id)
       set_state_field('${pk_name}',id)
      })
    ${state[pk_name] ? `
      const selnode = $("li[data-id=${state[pk_name]}]")
      tree.select(selnode);
      tree.expand(selnode);
      selnode.parents("li[data-id]").each(function() {tree.expand($(this))})` : ""}
    `)
    )
  );
};

const change_node = async (
  table_id,
  viewname,
  { title_field, parent_field, read_only },
  { id, topic, parent_id },
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
  if (topic) updRow[title_field] = topic;
  if (parent_id === "root") updRow[parent_field] = null;
  else if (parent_id) updRow[parent_field] = parent_id;
  await table.updateRow(updRow, id, req.user || { role_id: public_user_role });
  return { json: { success: "ok" } };
};

const delete_node = async (
  table_id,
  viewname,
  { title_field, read_only },
  { id },
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
  await table.deleteRows(
    { [table.pk_name]: id },
    req.user || { role_id: public_user_role }
  );
  return { json: { success: "ok" } };
};

const add_node = async (
  table_id,
  viewname,
  {
    title_field,
    parent_field,
    edit_view,
    root_relation_field,
    field_values_formula,
    read_only,
  },
  { topic, parent_id, root_value },
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

  const parent_id_val = parent_id === "root" ? null : parent_id;
  let newRowValues = {};
  if (field_values_formula) {
    const ctx = getState().function_context;
    if (parent_id_val) {
      ctx.parent = await table.getRow({ [table.pk_name]: parent_id_val });
    }
    newRowValues = runInNewContext(`()=>(${field_values_formula})`, ctx)();
  }
  const newRow = {
    ...newRowValues,
    [title_field]: topic,
    [parent_field]: parent_id_val,
  };
  if (
    root_relation_field &&
    root_value &&
    typeof newRow[root_relation_field] === "undefined"
  )
    newRow[root_relation_field] = root_value;
  const id = await table.insertRow(
    newRow,
    req.user || { role_id: public_user_role }
  );
  const newNode = { id, topic };
  if (edit_view) {
    newNode.hyperLink = `javascript:ajax_modal('/view/${edit_view}?${table.pk_name}=${id}')`;
  }

  return { json: { success: "ok", newNode } };
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
      routes: { change_node, add_node, delete_node },
    },
  ],
};
