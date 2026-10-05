"use client";

import { useEffect, useId, useRef, type ReactNode } from "react";
import {
  defaultWorkflowConfig,
  truncateWorkflowText,
  workflowTextLength,
  type WorkflowEdit,
  type WorkflowSnapshot,
} from "@/lib/automation-workflow-model";
import type { ValidationIssue, WorkflowNodeUpdate } from "@/lib/automation-workflow-types";
import {
  addConditionMember,
  catalogEntry,
  changeConditionField,
  changeConditionOperator,
  clearConditionValue,
  conditionOperators,
  conditionValueChoices,
  parseWorkflowInteger,
  removeConditionMember,
  supportedConditionField,
  unsupportedTemplateVariables,
  workflowApplicability,
  workflowReferenceLabel,
  workflowReferences,
  type WorkflowCatalogChoice,
  type WorkflowCatalogChoices,
  type WorkflowReferenceChoices,
} from "@/lib/automation-workflow-catalog";
import styles from "./workflow-node-inspector.module.css";

type Props = {
  draft: WorkflowSnapshot;
  selectedNodeId: string | null;
  catalog: WorkflowCatalogChoices;
  references: WorkflowReferenceChoices;
  onEdit: (edit: WorkflowEdit) => void;
  onClose: () => void;
  disabled?: boolean;
  issues: ValidationIssue[];
};
type FieldAttributes = {
  id: string;
  "aria-describedby": string | undefined;
  "aria-invalid": true | undefined;
};
function Field({
  label,
  name,
  issues,
  hint,
  children,
}: {
  label: string;
  name: string;
  issues: ValidationIssue[];
  hint?: ReactNode;
  children: (attributes: FieldAttributes) => ReactNode;
}) {
  const id = useId();
  const matching = issues.filter(
    (issue) =>
      issue.field === name ||
      issue.field === `config.${name}` ||
      issue.field?.startsWith(`config.${name}[`),
  );
  return (
    <div className={styles.field}>
      <label htmlFor={id}>{label}</label>
      {children({
        id,
        "aria-describedby": hint || matching.length ? `${id}-help` : undefined,
        "aria-invalid": matching.length ? true : undefined,
      })}
      {hint || matching.length ? (
        <div id={`${id}-help`} className={styles.help}>
          {hint}
          {matching.map((issue, index) => (
            <p className={styles.warning} key={index}>
              {issue.message}
            </p>
          ))}
        </div>
      ) : null}
    </div>
  );
}
function Choice({
  value,
  choices,
  placeholder,
  unavailableLabel,
  onChange,
  ...attributes
}: FieldAttributes & {
  value: string | null;
  choices: readonly WorkflowCatalogChoice[];
  placeholder: string;
  unavailableLabel?: string;
  onChange: (id: string | null) => void;
}) {
  const stale = value !== null && !choices.some((choice) => choice.id === value);
  return (
    <select
      {...attributes}
      value={value ?? ""}
      onChange={(event) => {
        const next = event.target.value;
        if (next === "" || choices.some((choice) => choice.id === next)) onChange(next || null);
      }}
    >
      <option value="">{placeholder}</option>
      {stale ? (
        <option value={value!} disabled>
          Unavailable: {unavailableLabel ?? value}
        </option>
      ) : null}
      {choices.map((choice) => (
        <option key={choice.id} value={choice.id}>
          {choice.label}
        </option>
      ))}
    </select>
  );
}
const names = {
  trigger: "Trigger",
  condition: "Condition",
  delay: "Delay",
  email: "Email",
  lead_follow_up: "Lead follow-up",
  end: "End",
};
const operatorLabels: Record<string, string> = {
  eq: "Is",
  neq: "Is not",
  in: "Is one of",
  not_in: "Is not one of",
};
const displayValue = (value: unknown) =>
  value === null ? "No value" : typeof value === "string" ? value : JSON.stringify(value);

export function WorkflowNodeInspector({
  draft,
  selectedNodeId,
  catalog,
  references,
  onEdit,
  onClose,
  disabled = false,
  issues,
}: Props) {
  const heading = useRef<HTMLHeadingElement>(null);
  const headingId = useId();
  const node = draft.graph.nodes.find((item) => item.id === selectedNodeId);
  useEffect(() => {
    if (selectedNodeId) heading.current?.focus();
  }, [selectedNodeId]);
  const applicable = workflowApplicability(draft, catalog);
  const nodeIssues = issues.filter(
    (issue) => issue.node_id === selectedNodeId && selectedNodeId !== null,
  );
  const edit = (update: WorkflowNodeUpdate) => {
    if (node && !disabled) onEdit({ kind: "update_config", node_id: node.id, update });
  };
  let form: ReactNode = null;

  if (node?.type === "trigger") {
    const config = node.config;
    const trigger = applicable.trigger;
    const programs = workflowReferences(references, "program.id");
    const programChoices = trigger?.supports_program_filter ? programs.choices : [];
    const { offset_minutes: savedOffset, ...withoutOffset } = config;
    form = (
      <>
        <Field label="Trigger event" name="event_type" issues={nodeIssues}>
          {(attrs) => (
            <Choice
              {...attrs}
              value={config.event_type}
              choices={Object.values(catalog.triggers)}
              placeholder="Choose an event"
              onChange={(event_type) =>
                edit({ type: "trigger", config: { ...config, event_type } })
              }
            />
          )}
        </Field>
        {trigger?.supports_program_filter || config.program_id !== null ? (
          <>
            <Field
              label="Program filter"
              name="program_id"
              issues={nodeIssues}
              hint={
                !trigger ? (
                  <p>{applicable.reason} The saved filter stays unchanged.</p>
                ) : !trigger.supports_program_filter ? (
                  <p>
                    This event does not support a program filter. Clear the saved filter or choose a
                    supported event.
                  </p>
                ) : programs.status !== "ready" ? (
                  <p>Program choices are {programs.status}. Saved filters stay unchanged.</p>
                ) : (
                  <p>Limit this workflow to the selected program.</p>
                )
              }
            >
              {(attrs) => (
                <Choice
                  {...attrs}
                  value={config.program_id}
                  choices={programChoices}
                  unavailableLabel={workflowReferenceLabel(
                    references,
                    "program.id",
                    config.program_id,
                  )}
                  placeholder="All programs"
                  onChange={(program_id) =>
                    edit({ type: "trigger", config: { ...config, program_id } })
                  }
                />
              )}
            </Field>
            {config.program_id !== null ? (
              <button
                type="button"
                onClick={() => edit({ type: "trigger", config: { ...config, program_id: null } })}
              >
                Clear filter
              </button>
            ) : null}
          </>
        ) : trigger ? (
          <p className={styles.help}>This event has no program filter.</p>
        ) : null}
        {trigger?.supports_offset ? (
          <Field
            label="Minutes before event"
            name="offset_minutes"
            issues={nodeIssues}
            hint={<p>Choose 1 to 129600 minutes before the event. Leave blank while unfinished.</p>}
          >
            {(attrs) => (
              <input
                {...attrs}
                type="number"
                min={1}
                max={129600}
                step={1}
                value={savedOffset === undefined ? "" : Math.abs(savedOffset)}
                onChange={(event) => {
                  if (event.target.value === "") edit({ type: "trigger", config: withoutOffset });
                  else {
                    const minutes = parseWorkflowInteger(event.target.value, 1, 129600);
                    if (minutes !== undefined)
                      edit({ type: "trigger", config: { ...config, offset_minutes: -minutes } });
                  }
                }}
              />
            )}
          </Field>
        ) : savedOffset !== undefined ? (
          <Field
            label="Saved upcoming offset"
            name="offset_minutes"
            issues={nodeIssues}
            hint={
              <p>
                {trigger ? "This event does not support an upcoming offset." : applicable.reason}{" "}
                The saved offset stays unchanged until you remove it.
              </p>
            }
          >
            {(attrs) => <input {...attrs} value={`${savedOffset} minutes`} readOnly />}
          </Field>
        ) : null}
        {savedOffset !== undefined ? (
          <button type="button" onClick={() => edit({ type: "trigger", config: withoutOffset })}>
            Remove offset
          </button>
        ) : null}
        <p className={styles.help}>
          Changing the event keeps the other steps. Review their settings for the new event.
        </p>
      </>
    );
  } else if (node?.type === "condition") {
    const config = node.config;
    const selectedField = catalogEntry(catalog.fields, config.field);
    const field = applicable.fields.find((item) => item.id === config.field);
    const operators = conditionOperators(field);
    const canCompare =
      !!field && supportedConditionField(field) && operators.includes(config.operator ?? "");
    const choices = canCompare ? conditionValueChoices(field, references) : [];
    const storedChoices = conditionValueChoices(selectedField, references);
    const savedValueLabel = (value: unknown) =>
      storedChoices.find((choice) => choice.value === value)?.label ??
      (typeof value === "string"
        ? workflowReferenceLabel(references, config.field, value)
        : undefined) ??
      displayValue(value);
    const membership = config.operator === "in" || config.operator === "not_in";
    const hasValue = Object.prototype.hasOwnProperty.call(config, "value");
    const nullAllowed = canCompare && field!.nullable && !membership;
    const reference =
      field?.value_type === "uuid" ? workflowReferences(references, field.id) : null;
    const valueKnown =
      hasValue &&
      ((config.value === null && nullAllowed) ||
        choices.some((choice) => choice.value === config.value));
    form = (
      <>
        <Field label="Comparison field" name="field" issues={nodeIssues}>
          {(attrs) => (
            <Choice
              {...attrs}
              value={config.field}
              choices={applicable.fields}
              unavailableLabel={selectedField?.label}
              placeholder="Choose a field"
              onChange={(id) =>
                edit({
                  type: "condition",
                  config: changeConditionField(
                    config,
                    applicable.fields.find((item) => item.id === id),
                    references,
                  ),
                })
              }
            />
          )}
        </Field>
        {config.field && !field ? (
          <p className={styles.warning}>
            The saved field is unavailable for this event. Choose another field or clear the
            comparison.
          </p>
        ) : null}
        {selectedField && !supportedConditionField(selectedField) ? (
          <p className={styles.warning}>
            This field type is not supported by this editor yet. The saved comparison is preserved.
            Choose another field or clear the comparison.
          </p>
        ) : null}
        <Field label="Comparison operator" name="operator" issues={nodeIssues}>
          {(attrs) => (
            <Choice
              {...attrs}
              value={config.operator}
              choices={operators.map((id) => ({
                id,
                label: catalogEntry(operatorLabels, id) ?? id,
              }))}
              unavailableLabel={catalogEntry(operatorLabels, config.operator)}
              placeholder="Choose an operator"
              onChange={(operator) =>
                edit({
                  type: "condition",
                  config: changeConditionOperator(config, operator, field),
                })
              }
            />
          )}
        </Field>
        <Field
          label={membership ? "Add comparison value" : "Comparison value"}
          name="value"
          issues={nodeIssues}
          hint={
            <>
              {!hasValue ? <p>Choose a value to finish this comparison.</p> : null}
              {reference && reference.status !== "ready" ? (
                <p>
                  Reference choices are {reference.status}. Saved values stay visible until you
                  clear or replace them.
                </p>
              ) : null}
              {membership ? (
                <p>Choose up to 100 values. Each value must match this field.</p>
              ) : null}
            </>
          }
        >
          {(attrs) => (
            <select
              {...attrs}
              disabled={
                !canCompare ||
                (membership &&
                  ((Array.isArray(config.value) && config.value.length >= 100) ||
                    (hasValue && !Array.isArray(config.value))))
              }
              value={membership || !hasValue ? "" : JSON.stringify(config.value)}
              onChange={(event) => {
                const token = event.target.value;
                if (token === "") {
                  if (!membership) edit({ type: "condition", config: clearConditionValue(config) });
                  return;
                }
                const value =
                  token === "null" && nullAllowed
                    ? null
                    : choices.find((choice) => JSON.stringify(choice.value) === token)?.value;
                if (value === undefined) return;
                if (membership && value !== null) {
                  const next = addConditionMember(config, value, field, references);
                  if (next) edit({ type: "condition", config: next });
                } else if (!membership)
                  edit({
                    type: "condition",
                    config: { field: config.field, operator: config.operator, value },
                  });
              }}
            >
              <option value="">{membership ? "Choose a value to add" : "Choose a value"}</option>
              {!membership && hasValue && !valueKnown ? (
                <option disabled value={JSON.stringify(config.value)}>
                  Unavailable: {savedValueLabel(config.value)}
                </option>
              ) : null}
              {nullAllowed ? <option value="null">No value</option> : null}
              {choices
                .filter(
                  (choice) =>
                    !membership ||
                    !Array.isArray(config.value) ||
                    !config.value.includes(choice.value),
                )
                .map((choice) => (
                  <option key={JSON.stringify(choice.value)} value={JSON.stringify(choice.value)}>
                    {choice.label}
                  </option>
                ))}
            </select>
          )}
        </Field>
        {Array.isArray(config.value) ? (
          <ul className={styles.members} aria-label="Saved comparison values">
            {config.value.map((value, index) => {
              const choice = choices.find((item) => item.value === value);
              return (
                <li key={index}>
                  <span>{choice?.label ?? `Unavailable: ${savedValueLabel(value)}`}</span>
                  <button
                    type="button"
                    aria-label={`Remove comparison value ${index + 1}: ${displayValue(value)}`}
                    onClick={() =>
                      edit({ type: "condition", config: removeConditionMember(config, index) })
                    }
                  >
                    Remove
                  </button>
                </li>
              );
            })}
          </ul>
        ) : membership && hasValue ? (
          <p className={styles.warning}>
            Saved value: {displayValue(config.value)}. Clear this value before adding a list.
          </p>
        ) : null}
        {hasValue ? (
          <button
            type="button"
            onClick={() => edit({ type: "condition", config: clearConditionValue(config) })}
          >
            Clear value
          </button>
        ) : null}
        <button
          type="button"
          onClick={() => edit({ type: "condition", config: defaultWorkflowConfig("condition") })}
        >
          Clear comparison
        </button>
      </>
    );
  } else if (node?.type === "delay") {
    const config = node.config;
    form = (
      <>
        <Field label="Delay mode" name="mode" issues={nodeIssues}>
          {(attrs) => (
            <select
              {...attrs}
              value={config.mode}
              onChange={(event) => {
                if (event.target.value === "duration")
                  edit({ type: "delay", config: defaultWorkflowConfig("delay") });
                else if (event.target.value === "until")
                  edit({
                    type: "delay",
                    config: { mode: "until", field: null, offset_minutes: 0 },
                  });
              }}
            >
              <option value="duration">Wait for a duration</option>
              <option value="until">Wait until an event time</option>
            </select>
          )}
        </Field>
        {config.mode === "duration" ? (
          <Field
            label="Duration in minutes"
            name="minutes"
            issues={nodeIssues}
            hint={<p>Use 0 to 129600 minutes. Leave blank while unfinished.</p>}
          >
            {(attrs) => (
              <input
                {...attrs}
                type="number"
                min={0}
                max={129600}
                step={1}
                value={config.minutes ?? ""}
                onChange={(event) => {
                  const minutes =
                    event.target.value === ""
                      ? null
                      : parseWorkflowInteger(event.target.value, 0, 129600);
                  if (minutes !== undefined)
                    edit({ type: "delay", config: { mode: "duration", minutes } });
                }}
              />
            )}
          </Field>
        ) : (
          <>
            <Field
              label="Event time"
              name="field"
              issues={nodeIssues}
              hint={
                !applicable.delayFields.length ? (
                  <p>
                    This trigger has no supported event time. Choose another trigger or use a
                    duration.
                  </p>
                ) : undefined
              }
            >
              {(attrs) => (
                <Choice
                  {...attrs}
                  value={config.field}
                  choices={applicable.delayFields}
                  unavailableLabel={catalogEntry(catalog.delay_fields, config.field)?.label}
                  placeholder="Choose an event time"
                  onChange={(field) => edit({ type: "delay", config: { ...config, field } })}
                />
              )}
            </Field>
            {config.field ? (
              <button
                type="button"
                onClick={() => edit({ type: "delay", config: { ...config, field: null } })}
              >
                Clear event time
              </button>
            ) : null}
            <Field label="Timing" name="offset_minutes" issues={nodeIssues}>
              {(attrs) => (
                <select
                  {...attrs}
                  value={
                    config.offset_minutes < 0
                      ? "before"
                      : config.offset_minutes > 0
                        ? "after"
                        : "at"
                  }
                  onChange={(event) => {
                    const sign =
                      event.target.value === "before" ? -1 : event.target.value === "after" ? 1 : 0;
                    edit({
                      type: "delay",
                      config: {
                        ...config,
                        offset_minutes: sign * (Math.abs(config.offset_minutes) || 1),
                      },
                    });
                  }}
                >
                  <option value="at">At event time</option>
                  <option value="before">Before event time</option>
                  <option value="after">After event time</option>
                </select>
              )}
            </Field>
            {config.offset_minutes !== 0 ? (
              <Field
                label="Offset in minutes"
                name="offset_minutes"
                issues={nodeIssues}
                hint={<p>Use 0 to 129600 minutes. Clearing returns to At event time.</p>}
              >
                {(attrs) => (
                  <input
                    {...attrs}
                    type="number"
                    min={0}
                    max={129600}
                    step={1}
                    value={Math.abs(config.offset_minutes)}
                    onChange={(event) => {
                      const magnitude =
                        event.target.value === ""
                          ? 0
                          : parseWorkflowInteger(event.target.value, 0, 129600);
                      if (magnitude !== undefined)
                        edit({
                          type: "delay",
                          config: {
                            ...config,
                            offset_minutes: magnitude * (config.offset_minutes < 0 ? -1 : 1),
                          },
                        });
                    }}
                  />
                )}
              </Field>
            ) : null}
            <p className={styles.help}>
              Event dates use the event or studio timezone. An obsolete pre-event reminder is
              skipped once the event has started.
            </p>
          </>
        )}
      </>
    );
  } else if (node?.type === "email") {
    const config = node.config;
    const textField = (
      name: "subject_template" | "body_template",
      label: string,
      limit: number,
    ) => {
      const unsupported = unsupportedTemplateVariables(config[name], applicable.variables);
      const textLength = workflowTextLength(config[name]);
      return (
        <div key={name}>
          <Field
            label={label}
            name={name}
            issues={nodeIssues}
            hint={
              unsupported.length ? (
                <p className={styles.warning}>
                  Unavailable placeholders: {unsupported.map((id) => `{{${id}}}`).join(", ")}. Edit
                  the text or choose an event that supports them.
                </p>
              ) : undefined
            }
          >
            {(attrs) =>
              name === "subject_template" ? (
                <input
                  {...attrs}
                  type="text"
                  value={config[name]}
                  onChange={(event) =>
                    edit({
                      type: "email",
                      config: {
                        ...config,
                        [name]: truncateWorkflowText(event.target.value, limit),
                      },
                    })
                  }
                />
              ) : (
                <textarea
                  {...attrs}
                  rows={7}
                  value={config[name]}
                  onChange={(event) =>
                    edit({
                      type: "email",
                      config: {
                        ...config,
                        [name]: truncateWorkflowText(event.target.value, limit),
                      },
                    })
                  }
                />
              )
            }
          </Field>
          <label className={styles.variablePicker}>
            <span>Insert variable into {label.toLowerCase()}</span>
            <select
              aria-label={`Insert variable into ${label.toLowerCase()}`}
              value=""
              onChange={(event) => {
                const variable = applicable.variables.find(
                  (item) => item.id === event.target.value,
                );
                if (variable && textLength + workflowTextLength(variable.id) + 4 <= limit)
                  edit({
                    type: "email",
                    config: { ...config, [name]: config[name] + `{{${variable.id}}}` },
                  });
              }}
            >
              <option value="">Choose a variable to append</option>
              {applicable.variables.map((variable) => (
                <option
                  key={variable.id}
                  value={variable.id}
                  disabled={textLength + workflowTextLength(variable.id) + 4 > limit}
                >
                  {variable.label}
                </option>
              ))}
            </select>
          </label>
        </div>
      );
    };
    form = (
      <>
        <Field label="Recipient policy" name="recipient" issues={nodeIssues}>
          {(attrs) => (
            <Choice
              {...attrs}
              value={config.recipient}
              choices={applicable.recipients}
              unavailableLabel={catalogEntry(catalog.recipients, config.recipient)?.label}
              placeholder="Choose a recipient policy"
              onChange={(recipient) => edit({ type: "email", config: { ...config, recipient } })}
            />
          )}
        </Field>
        {config.recipient && !applicable.recipients.some((item) => item.id === config.recipient) ? (
          <p className={styles.warning}>
            The saved recipient policy is unavailable for this event. Choose a supported policy or
            clear it.
          </p>
        ) : null}
        {textField("subject_template", "Subject", 200)}
        {textField("body_template", "Message", 5000)}
        <p className={styles.help}>
          Messages use plain text. You can edit or remove inserted placeholders.
        </p>
        {applicable.variables.some((variable) => variable.fallback !== null) ? (
          <details>
            <summary>Variable fallbacks</summary>
            <ul>
              {applicable.variables
                .filter((variable) => variable.fallback !== null)
                .map((variable) => (
                  <li key={variable.id}>
                    {variable.label}: {variable.fallback}
                  </li>
                ))}
            </ul>
          </details>
        ) : null}
        <Field
          label="Reply-to email"
          name="reply_to_email"
          issues={nodeIssues}
          hint={<p>Leave blank to use the sender default.</p>}
        >
          {(attrs) => (
            <input
              {...attrs}
              type="email"
              value={config.reply_to_email}
              onChange={(event) =>
                edit({
                  type: "email",
                  config: {
                    ...config,
                    reply_to_email: truncateWorkflowText(event.target.value, 254),
                  },
                })
              }
            />
          )}
        </Field>
      </>
    );
  } else if (node?.type === "lead_follow_up") {
    const config = node.config;
    form = (
      <>
        {!applicable.trigger?.supports_lead_follow_up ? (
          <p className={styles.warning}>
            This event does not support lead follow-up. Change the trigger event or remove this step
            in the graph. Your settings are preserved.
          </p>
        ) : null}
        <Field
          label="Follow-up due in days"
          name="due_in_days"
          issues={nodeIssues}
          hint={<p>Use 0 to 90 days. An earlier existing follow-up date stays in place.</p>}
        >
          {(attrs) => (
            <input
              {...attrs}
              type="number"
              min={0}
              max={90}
              step={1}
              value={config.due_in_days ?? ""}
              onChange={(event) => {
                const due_in_days =
                  event.target.value === ""
                    ? null
                    : parseWorkflowInteger(event.target.value, 0, 90);
                if (due_in_days !== undefined)
                  edit({ type: "lead_follow_up", config: { ...config, due_in_days } });
              }}
            />
          )}
        </Field>
        <Field label="Follow-up note" name="note" issues={nodeIssues}>
          {(attrs) => (
            <textarea
              {...attrs}
              rows={5}
              value={config.note}
              onChange={(event) =>
                edit({
                  type: "lead_follow_up",
                  config: { ...config, note: truncateWorkflowText(event.target.value, 1000) },
                })
              }
            />
          )}
        </Field>
      </>
    );
  } else if (node?.type === "end") form = <p>This branch finishes when it reaches this step.</p>;

  return (
    <aside className={styles.inspector} aria-labelledby={headingId}>
      <header className={styles.header}>
        <h2 id={headingId} ref={heading} tabIndex={-1}>
          {node ? `${names[node.type]} settings` : "Step settings"}
        </h2>
        <button type="button" onClick={onClose}>
          Close settings
        </button>
      </header>
      {!node ? (
        <p>Select a step to configure it.</p>
      ) : (
        <>
          {nodeIssues.length ? (
            <section aria-label="Step issues" className={styles.issueSummary}>
              <h3>Review this step</h3>
              <ul>
                {nodeIssues.map((issue, index) => (
                  <li key={index}>{issue.message}</li>
                ))}
              </ul>
            </section>
          ) : null}
          {applicable.reason && node.type !== "end" ? (
            <p className={styles.warning}>{applicable.reason}</p>
          ) : null}
          {disabled ? (
            <p className={styles.help}>
              Editing is disabled. You can read these settings or close this panel.
            </p>
          ) : null}
          <form onSubmit={(event) => event.preventDefault()}>
            <fieldset disabled={disabled} className={styles.fields}>
              <legend className={styles.srOnly}>{names[node.type]} configuration</legend>
              {form}
            </fieldset>
          </form>
        </>
      )}
    </aside>
  );
}
