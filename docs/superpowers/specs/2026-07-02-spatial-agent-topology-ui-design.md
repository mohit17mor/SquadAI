# Spatial Agent Topology UI Design

## Objective

Replace the current command-center home screen with a professional, lightweight
3D topology that makes the agent system feel alive and understandable. The
topology is the primary navigation surface. Existing conversations, tool-call
details, approvals, events, work items, agent configuration, and live updates
remain available through focused 2D panels.

This phase changes presentation and interaction only. It does not redesign the
manager's routing, persistence, approval, or execution behavior.

## Product Principles

1. **Topology first.** The default screen shows agents, sources, and their live
   relationships rather than a conventional dashboard.
2. **Meaningful motion.** Animation communicates real state: event arrival,
   routing, delegation, execution, approval, failure, or completion.
3. **Details on demand.** The 3D scene provides system awareness; readable 2D
   panels provide conversations, tool output, controls, and configuration.
4. **Lightweight by construction.** Use simple sphere meshes, a bounded render
   loop, and ordinary HTML/CSS for text-heavy UI. Do not render conversations or
   forms inside WebGL.
5. **No decorative fiction.** Every color, connection, pulse, and status ring
   must correspond to manager state or a durable event.
6. **Future workflow editing.** The interaction model must leave room for an
   n8n-like agent builder without claiming unsupported backend behavior today.

## Information Architecture

### Primary topology canvas

The canvas occupies the main viewport and contains:

- one sphere per agent;
- one distinct sphere per configured event source;
- persistent configured connections when known;
- temporary runtime connections for routing or agent-to-agent activity;
- moving event pulses derived from manager events;
- compact labels with name, role, status, and current activity;
- pan, zoom, orbit, fit-to-view, and optional 2D/3D toggle;
- selection, connect, add-agent, add-source, search, and auto-layout controls.

The initial release visualizes the current manager model. Connection editing may
be presented as a disabled or clearly labelled preview until a durable backend
connection model exists.

### Navigation

A slim navigation rail provides direct access to:

- Topology;
- Work;
- Conversations;
- Events;
- Approvals;
- Agent management;
- Settings.

Topology is the default route. Existing operational views remain accessible and
retain their current capabilities.

### Inspector

Selecting an agent opens a right-side inspector with:

- status and current action;
- elapsed time and thread identity;
- model and runtime settings;
- permissions and pending approvals;
- recent tool calls;
- token/time indicators when the backend provides them;
- Open conversation, Pause/Cancel, Edit, and Remove actions.

Selecting an event source or connection uses the same panel shell with
type-specific content.

### Conversation workspace

Open conversation transitions to a focused workspace that preserves:

- complete user and assistant messages;
- completed tool calls and command output;
- compaction and retry activity;
- inline approval controls;
- message composer and network option;
- cancel/interrupt action;
- links back to the selected topology node.

The conversation workspace remains DOM-based for accessibility, text selection,
copying, and predictable performance.

## Visual Language

- Deep graphite spatial canvas with restrained depth cues.
- Agent nodes are elegant spheres with a core material, thin orbital rings, and
  small status halos.
- Router and Jarvis may be slightly larger but use the same visual grammar.
- Running is green, incoming events cyan, active routing indigo, approvals amber,
  and failures red. Color is always reinforced with text or iconography.
- Connections are thin filaments. Directional particles appear only while work
  or information is actively moving.
- Panels use crisp typography, subtle separators, and minimal elevation.
- Avoid robots, characters, neon overload, metaverse styling, heavy bloom,
  glassmorphism, chunky platforms, and game-like effects.

## State Mapping

| Manager state or event | Topology representation |
| --- | --- |
| Agent idle | Stationary sphere, neutral halo |
| Agent starting | Slow orbit animation |
| Agent running | Active status ring and concise activity label |
| Agent failed | Red status marker, no continuous attention animation |
| Agent stopped | Dimmed sphere |
| Sensor event ingested | Pulse enters from the source node |
| Sensor event routing | Pulse travels to the router |
| Sensor event routed | Pulse travels from router to target worker |
| Work item running | Target sphere activates; work connection remains visible |
| Approval requested | Amber halo and approval badge |
| Turn retrying | Subtle reconnect indicator |
| Work completed | Brief success pulse, then return to steady state |

When the existing event stream cannot establish a relationship reliably, the UI
must show no link rather than infer one.

## Frontend Architecture

The existing server currently embeds HTML, CSS, and JavaScript in one TypeScript
file. The redesign should first extract the browser application into focused
static modules served by the command-center server:

- `ui/index.html` for the application shell;
- `ui/styles.css` for tokens and layout;
- `ui/app.js` for routing and API/SSE state;
- `ui/topology.js` for scene setup, nodes, links, animation, and picking;
- `ui/views/` modules for conversation, work, events, approvals, and settings.

The server remains dependency-light and continues to expose the existing API.
Use a small, established WebGL library only if it materially reduces scene and
interaction complexity. The topology renderer must sit behind a narrow adapter
so it can be replaced without changing application state or API code.

### Normalized client state

The browser maintains normalized maps for agents, events, work items, and
notifications. SSE events update these maps and feed a bounded animation queue.
The full event history is not copied into GPU objects.

### Performance constraints

- Render continuously only while the scene is moving or the user is interacting.
- Pause or reduce rendering when the tab is hidden.
- Cap transient particles and discard expired animations.
- Use one sphere geometry/material family with instancing where practical.
- Keep labels and inspectors in the DOM.
- Respect `prefers-reduced-motion` and offer a motion toggle.
- Provide a functional 2D fallback if WebGL initialization fails.

## Data Flow

1. Initial REST requests load agents, events, sensor events, work items, and
   notifications.
2. Client state derives topology nodes and known relationships.
3. SSE events update client state immediately.
4. A topology event adapter translates relevant events into short-lived visual
   animations.
5. User selection updates the inspector without starting agent work.
6. Existing API endpoints handle messages, approvals, cancellation, editing,
   deletion, retry, and creation.
7. After any mutating request, the UI reconciles with authoritative REST state.

## Error Handling

- SSE disconnects show a clear reconnecting state and trigger REST reconciliation
  after reconnection.
- Missing or malformed event payloads are ignored by the animation layer but
  remain visible in the event log.
- WebGL failure switches to the 2D topology fallback without blocking other UI.
- API failures appear next to the action that failed and never optimistically
  remove agents or approvals.
- Deleting a selected node requires confirmation and uses existing manager
  safeguards for active work.
- Unsupported future connection edits are never represented as saved state.

## Accessibility

- Every topology node is mirrored in a keyboard-navigable agent list.
- Keyboard selection opens the same inspector as pointer selection.
- Status is not communicated by color alone.
- Motion can be reduced or disabled.
- Conversation and approval controls follow normal DOM focus order.
- Canvas actions expose accessible names and visible focus states.

## Testing

### Unit and integration tests

- topology state derivation from manager snapshots;
- event-to-animation mapping;
- selection and inspector state;
- agent creation, editing, cancellation, and deletion flows;
- approval resolution;
- SSE reconnect and REST reconciliation;
- WebGL failure fallback;
- reduced-motion behavior.

### Browser verification

- test the primary screen at common desktop widths;
- verify labels do not overlap critically at the initial agent counts;
- verify all existing UI capabilities remain reachable;
- verify keyboard navigation and focus handling;
- verify idle rendering does not continuously consume significant CPU;
- compare the implemented screen against the approved spatial visual direction.

### Existing regression suite

All current manager and server tests must continue to pass. API contracts remain
unchanged in this phase unless a separately reviewed addition is required for
accurate visualization.

## Delivery Sequence

1. Extract the embedded UI without changing behavior.
2. Introduce normalized browser state and view routing.
3. Build the lightweight topology renderer and 2D fallback.
4. Add inspector and conversation workspace.
5. Map live manager events to topology animations.
6. Restore and verify all existing operational screens and actions.
7. Run performance, accessibility, regression, and visual QA.

## Explicit Non-Goals

- Changing agent execution, routing, or approval semantics.
- Implementing arbitrary persisted agent-to-agent connections in this phase.
- Building a complete n8n-style workflow engine now.
- Replacing Codex App Server or the manager API.
- Rendering full conversations, logs, or forms inside WebGL.
- Adding decorative animations that are not backed by system state.
