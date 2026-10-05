"use client";

import { memo, useCallback, useMemo, useState } from "react";
import { Background, Controls, Handle, MarkerType, Position, ReactFlow } from "@xyflow/react";
import type {
  Connection,
  Edge,
  IsValidConnection,
  Node,
  NodeProps,
  NodeTypes,
  OnConnect,
  OnConnectEnd,
  OnEdgesChange,
  OnNodesChange,
} from "@xyflow/react";
import {
  editWorkflow,
  fillWorkflowPositions,
  nextWorkflowId,
  workflowPorts,
} from "@/lib/automation-workflow-model";
import type { WorkflowEdit, WorkflowSnapshot } from "@/lib/automation-workflow-model";
import type {
  ValidationIssue,
  WorkflowNodeType,
  WorkflowPosition,
  WorkflowPort,
} from "@/lib/automation-workflow-types";
import "@xyflow/react/dist/style.css";
import styles from "./workflow-graph-editor.module.css";

type CardNode = Node<
  { kind: WorkflowNodeType; label: string; summary: string; issue: boolean },
  "workflow"
>;
export type WorkflowCanvasProps = {
  draft: WorkflowSnapshot;
  selectedNodeId: string | null;
  onSelectNode: (id: string | null) => void;
  onEdit: (edit: WorkflowEdit) => boolean;
  onDeleteNode: (id: string) => void;
  onError: (message: string) => void;
  disabled: boolean;
  text: Record<string, { label: string; summary: string }>;
  issues: ValidationIssue[];
};

const WorkflowCard = memo(function WorkflowCard({
  data,
  selected,
  isConnectable,
}: NodeProps<CardNode>) {
  return (
    <div className={styles.nodeCard} data-selected={selected} data-issue={data.issue}>
      {data.kind !== "trigger" ? (
        <Handle
          type="target"
          position={Position.Left}
          isConnectable={isConnectable}
          aria-label={`Connect to ${data.label}`}
        />
      ) : null}
      <strong>{data.label}</strong>
      <p>{data.summary}</p>
      {data.issue ? <span className={styles.issueBadge}>Needs attention</span> : null}
      {workflowPorts(data.kind).map((port) => (
        <div key={port}>
          <span
            className={styles.portLabel}
            style={{ top: port === "yes" ? "38%" : port === "no" ? "76%" : "50%" }}
          >
            {port}
          </span>
          <Handle
            type="source"
            position={Position.Right}
            id={port}
            isConnectable={isConnectable}
            style={{ top: port === "yes" ? "38%" : port === "no" ? "76%" : "50%" }}
            aria-label={`${port} from ${data.label}`}
          />
        </div>
      ))}
    </div>
  );
});
const nodeTypes: NodeTypes = { workflow: WorkflowCard };
const fitOptions = { padding: 0.18, maxZoom: 1 };
const ariaLabels = {
  "node.a11yDescription.default":
    "Press Enter or Space to select, arrow keys to move, Delete to remove, or Escape to clear selection. Use Steps view to connect branches with the keyboard.",
  "node.a11yDescription.keyboardDisabled": "Press Enter or Space to select. Editing is disabled.",
  "edge.a11yDescription.default":
    "Press Enter or Space to select a connection, Delete to disconnect, or Escape to clear selection.",
};
const disabledAriaLabels = {
  ...ariaLabels,
  "node.a11yDescription.default":
    "Editing is disabled. Press Enter or Space to select a step, or Escape to clear selection.",
  "edge.a11yDescription.default":
    "Editing is disabled. Press Enter or Space to select a connection, or Escape to clear selection.",
};
const connectionEdit = (connection: Connection | Edge, id: string): WorkflowEdit | null => {
  const port = connection.sourceHandle;
  if (!connection.source || !connection.target || !["next", "yes", "no"].includes(port ?? ""))
    return null;
  return {
    kind: "connect",
    edge: { id, source: connection.source, target: connection.target, port: port as WorkflowPort },
  };
};

export default function WorkflowCanvas({
  draft,
  selectedNodeId,
  onSelectNode,
  onEdit,
  onDeleteNode,
  onError,
  disabled,
  text,
  issues,
}: WorkflowCanvasProps) {
  const [drag, setDrag] = useState<{
    draft: WorkflowSnapshot;
    positions: Record<string, WorkflowPosition>;
  } | null>(null);
  const [selectedEdge, setSelectedEdge] = useState<string | null>(null);
  const positioned = useMemo(() => fillWorkflowPositions(draft), [draft]);
  const nodes = useMemo<CardNode[]>(
    () =>
      draft.graph.nodes.map((node) => ({
        id: node.id,
        type: "workflow",
        width: 240,
        height: 132,
        position:
          (!disabled && drag?.draft === draft && Object.hasOwn(drag.positions, node.id)
            ? drag.positions[node.id]
            : undefined) ?? positioned.layout.positions[node.id],
        selected: selectedNodeId === node.id,
        data: {
          kind: node.type,
          ...text[node.id],
          issue: issues.some((issue) => issue.node_id === node.id),
        },
        ariaLabel: `${text[node.id].label}. ${text[node.id].summary}`,
      })),
    [draft, drag, disabled, positioned, selectedNodeId, text, issues],
  );
  const edges = useMemo<Edge[]>(
    () =>
      draft.graph.edges
        .filter((edge) => Object.hasOwn(text, edge.source) && Object.hasOwn(text, edge.target))
        .map((edge) => ({
          ...edge,
          sourceHandle: edge.port,
          markerEnd: { type: MarkerType.ArrowClosed },
          label: edge.port,
          selected: selectedEdge === edge.id,
          reconnectable: false,
          ariaLabel: `${edge.port} from ${text[edge.source].label} to ${text[edge.target].label}`,
          className: issues.some((issue) => issue.edge_id === edge.id)
            ? styles.issueEdge
            : undefined,
        })),
    [draft.graph.edges, selectedEdge, text, issues],
  );
  const changeNodes = useCallback<OnNodesChange<CardNode>>(
    (changes) => {
      for (const change of changes) {
        if (change.type === "select") {
          if (change.selected) {
            onSelectNode(change.id);
            setSelectedEdge(null);
          } else if (
            selectedNodeId === change.id &&
            !changes.some((item) => item.type === "select" && item.selected)
          )
            onSelectNode(null);
        }
        if (!disabled && change.type === "position" && change.position) {
          if (change.dragging) {
            const position = change.position;
            setDrag((previous) => ({
              draft,
              positions: {
                ...(previous?.draft === draft ? previous.positions : {}),
                [change.id]: position,
              },
            }));
          } else {
            // React Flow v12 emits dragging=false once at pointer release and for a keyboard move.
            onEdit({ kind: "commit_position", node_id: change.id, position: change.position });
            setDrag(null);
          }
        }
      }
    },
    [disabled, draft, onEdit, onSelectNode, selectedNodeId],
  );
  const changeEdges = useCallback<OnEdgesChange>(
    (changes) => {
      const selected = changes.find((change) => change.type === "select" && change.selected);
      if (selected?.type === "select") {
        setSelectedEdge(selected.id);
        onSelectNode(null);
      } else {
        setSelectedEdge((current) =>
          changes.some(
            (change) => change.type === "select" && !change.selected && change.id === current,
          )
            ? null
            : current,
        );
      }
    },
    [onSelectNode],
  );
  const validateConnection = useCallback<IsValidConnection>(
    (connection) => {
      const edit = connectionEdit(connection, nextWorkflowId(draft.graph, "edge"));
      return !disabled && edit !== null && editWorkflow(draft, edit).ok;
    },
    [disabled, draft],
  );
  const connect = useCallback<OnConnect>(
    (connection) => {
      const edit = connectionEdit(connection, nextWorkflowId(draft.graph, "edge"));
      if (edit) onEdit(edit);
    },
    [onEdit, draft.graph],
  );
  const endConnection = useCallback<OnConnectEnd>(
    (_event, state) => {
      if (disabled || state.isValid || !state.fromNode || !state.toNode || !state.fromHandle)
        return;
      const edit = connectionEdit(
        {
          source: state.fromNode.id,
          target: state.toNode.id,
          sourceHandle: state.fromHandle.id ?? null,
          targetHandle: null,
        },
        nextWorkflowId(draft.graph, "edge"),
      );
      const result = edit && editWorkflow(draft, edit);
      if (result && !result.ok) onError(result.reason);
    },
    [disabled, draft, onError],
  );
  const selectNode = useCallback(
    (_event: React.MouseEvent, node: CardNode) => {
      setSelectedEdge(null);
      onSelectNode(node.id);
    },
    [onSelectNode],
  );
  const clearSelection = useCallback(() => {
    setSelectedEdge(null);
    onSelectNode(null);
  }, [onSelectNode]);
  return (
    <div>
      <p className={styles.help}>
        {disabled
          ? "Editing is disabled. Tab to a step or connection and select with Enter or Space. Drag the background to pan, or use the zoom controls."
          : "Tab to a step or connection. Select with Enter or Space, move selected steps with arrow keys, and remove with Delete. Use Steps for keyboard connections. Drag the background to pan."}
      </p>
      <div
        className={styles.canvas}
        aria-label="Workflow graph"
        onKeyDown={(event) => {
          const target = event.target as HTMLElement;
          if (
            disabled ||
            !["Delete", "Backspace"].includes(event.key) ||
            target.closest("button, input, select, textarea")
          )
            return;
          const node = target.closest<HTMLElement>(".react-flow__node");
          const edge = target.closest<HTMLElement>(".react-flow__edge");
          if (node?.dataset.id) {
            event.preventDefault();
            onDeleteNode(node.dataset.id);
          } else if (edge?.dataset.id) {
            event.preventDefault();
            onEdit({ kind: "disconnect", edge_id: edge.dataset.id });
            setSelectedEdge(null);
          }
        }}
      >
        <ReactFlow<CardNode>
          nodes={nodes}
          edges={edges}
          nodeTypes={nodeTypes}
          onNodesChange={changeNodes}
          onEdgesChange={changeEdges}
          onNodeClick={selectNode}
          onPaneClick={clearSelection}
          onConnect={connect}
          onConnectEnd={endConnection}
          onClickConnectEnd={endConnection}
          isValidConnection={validateConnection}
          nodesDraggable={!disabled}
          nodesConnectable={!disabled}
          nodesFocusable
          edgesFocusable
          deleteKeyCode={null}
          multiSelectionKeyCode={null}
          selectionOnDrag={false}
          selectionKeyCode={null}
          fitView
          fitViewOptions={fitOptions}
          minZoom={0.2}
          maxZoom={1.5}
          ariaLabelConfig={disabled ? disabledAriaLabels : ariaLabels}
        >
          <Background gap={20} />
          <Controls showInteractive={false} />
        </ReactFlow>
      </div>
    </div>
  );
}
