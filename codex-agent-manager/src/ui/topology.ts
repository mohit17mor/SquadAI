import * as THREE from "three";

type AgentStatus = "idle" | "starting" | "running" | "failed" | "blocked" | "stopped";

type AgentSnapshot = {
  id: string;
  name: string;
  status: AgentStatus;
  threadId: string | null;
  model: string | null;
  reasoningEffort: string | null;
  serviceTier: string | null;
  approvalPolicy: "untrusted" | "on-failure" | "on-request" | "never";
  approvalsReviewer: "user" | "auto_review";
  sandbox: "read-only" | "workspace-write" | "danger-full-access";
  cwd: string;
  metadata: Record<string, unknown>;
};

type AgentEvent = {
  id: number;
  agentId: string;
  type: string;
  message: string;
  createdAt: string;
  payload: Record<string, unknown>;
};

type SensorEventSnapshot = {
  source: string;
  targetAgentId?: string;
};

type NodeRecord = {
  agent: AgentSnapshot;
  group: THREE.Group;
  sphere: THREE.Mesh<THREE.SphereGeometry, THREE.MeshPhysicalMaterial>;
  halo: THREE.Mesh<THREE.TorusGeometry, THREE.MeshBasicMaterial>;
  label: HTMLButtonElement;
};

type SourceRecord = {
  group: THREE.Group;
  label: HTMLDivElement;
};

type ConnectionRecord = {
  line: THREE.Line<THREE.BufferGeometry, THREE.LineBasicMaterial>;
  from: THREE.Vector3;
  to: THREE.Vector3;
};

type NodeDrag = {
  node: NodeRecord;
  plane: THREE.Plane;
  offset: THREE.Vector3;
};

const TOPOLOGY_LAYOUT_KEY = "jarvis.topology.agent-positions.v1";

const canvas = document.querySelector<HTMLCanvasElement>("#topology-canvas");
const workspace = document.querySelector<HTMLElement>("#topology-workspace");
const labelLayer = document.querySelector<HTMLElement>("#topology-agent-list");
const inspector = document.querySelector<HTMLElement>("#topology-inspector");
const search = document.querySelector<HTMLInputElement>("#topology-search");
const motionToggle = document.querySelector<HTMLButtonElement>("#topology-motion-toggle");
const fallback = document.querySelector<HTMLElement>("#topology-fallback");

if (canvas && workspace && labelLayer && inspector) {
  startTopology(canvas, workspace, labelLayer, inspector);
}

function startTopology(
  canvasElement: HTMLCanvasElement,
  workspaceElement: HTMLElement,
  labelsElement: HTMLElement,
  inspectorElement: HTMLElement,
): void {
  const reducedMotionQuery = window.matchMedia("(prefers-reduced-motion: reduce)");
  let motionEnabled = !reducedMotionQuery.matches;
  let renderer: THREE.WebGLRenderer;
  try {
    renderer = new THREE.WebGLRenderer({
      canvas: canvasElement,
      antialias: true,
      alpha: true,
      powerPreference: "high-performance",
    });
  } catch {
    canvasElement.hidden = true;
    fallback?.removeAttribute("hidden");
    void refreshFallback();
    return;
  }

  renderer.setPixelRatio(Math.min(window.devicePixelRatio, 1.6));
  renderer.outputColorSpace = THREE.SRGBColorSpace;

  const scene = new THREE.Scene();
  scene.fog = new THREE.FogExp2(0x070a12, 0.036);
  const camera = new THREE.PerspectiveCamera(42, 1, 0.1, 100);
  camera.position.set(0, 4.8, 12.5);
  camera.lookAt(0, 0, 0);

  const world = new THREE.Group();
  scene.add(world);
  scene.add(new THREE.HemisphereLight(0xaabfff, 0x10131e, 2.4));
  const keyLight = new THREE.DirectionalLight(0xffffff, 3.2);
  keyLight.position.set(4, 8, 7);
  scene.add(keyLight);

  const floor = new THREE.GridHelper(28, 36, 0x29304a, 0x151a29);
  floor.position.y = -2.3;
  floor.material.transparent = true;
  floor.material.opacity = 0.2;
  scene.add(floor);

  const nodes = new Map<string, NodeRecord>();
  const sourceNodes = new Map<string, SourceRecord>();
  const savedPositions = loadSavedPositions();
  const connections: ConnectionRecord[] = [];
  const raycaster = new THREE.Raycaster();
  const pointer = new THREE.Vector2();
  const pulses: Array<{ mesh: THREE.Mesh; from: THREE.Vector3; to: THREE.Vector3; started: number }> = [];
  let agents: AgentSnapshot[] = [];
  let sensorSources: string[] = [];
  let sensorEvents: SensorEventSnapshot[] = [];
  let routingMode = "explicit";
  let selectedAgentId: string | null = null;
  let rotating = false;
  let nodeDrag: NodeDrag | null = null;
  let lastPointer = { x: 0, y: 0 };
  let dragOrigin = { x: 0, y: 0 };
  let frameCount = 0;
  let needsRender = true;

  const resizeObserver = new ResizeObserver(() => {
    const rect = canvasElement.getBoundingClientRect();
    if (!rect.width || !rect.height) return;
    renderer.setSize(rect.width, rect.height, false);
    camera.aspect = rect.width / rect.height;
    camera.updateProjectionMatrix();
    needsRender = true;
  });
  resizeObserver.observe(canvasElement);

  canvasElement.addEventListener("pointerdown", (event) => {
    lastPointer = { x: event.clientX, y: event.clientY };
    dragOrigin = { ...lastPointer };
    const node = nodeFromPointer(event);
    if (node) {
      selectAgent(node.agent.id);
      const worldPosition = node.group.getWorldPosition(new THREE.Vector3());
      const plane = new THREE.Plane().setFromNormalAndCoplanarPoint(
        camera.getWorldDirection(new THREE.Vector3()),
        worldPosition,
      );
      const intersection = pointerPlaneIntersection(event, plane);
      nodeDrag = {
        node,
        plane,
        offset: intersection ? worldPosition.clone().sub(intersection) : new THREE.Vector3(),
      };
      canvasElement.classList.add("dragging-node");
    } else {
      rotating = true;
    }
    canvasElement.setPointerCapture(event.pointerId);
  });
  canvasElement.addEventListener("pointermove", (event) => {
    if (nodeDrag) {
      const intersection = pointerPlaneIntersection(event, nodeDrag.plane);
      if (!intersection) return;
      const localPosition = world.worldToLocal(intersection.add(nodeDrag.offset));
      localPosition.x = THREE.MathUtils.clamp(localPosition.x, -7.5, 7.5);
      localPosition.y = THREE.MathUtils.clamp(localPosition.y, -4.3, 4.3);
      localPosition.z = THREE.MathUtils.clamp(localPosition.z, -2.5, 2.5);
      nodeDrag.node.group.position.copy(localPosition);
      updateConnections();
      needsRender = true;
      return;
    }
    if (!rotating) {
      canvasElement.classList.toggle("over-agent", Boolean(nodeFromPointer(event)));
      return;
    }
    world.rotation.y += (event.clientX - lastPointer.x) * 0.004;
    world.rotation.x = THREE.MathUtils.clamp(
      world.rotation.x + (event.clientY - lastPointer.y) * 0.002,
      -0.25,
      0.35,
    );
    lastPointer = { x: event.clientX, y: event.clientY };
    needsRender = true;
  });
  const finishPointerInteraction = (event: PointerEvent): void => {
    const moved = Math.abs(event.clientX - dragOrigin.x) + Math.abs(event.clientY - dragOrigin.y);
    if (nodeDrag) {
      savedPositions.set(nodeDrag.node.agent.id, nodeDrag.node.group.position.clone());
      savePositions(savedPositions);
    }
    const wasRotating = rotating;
    rotating = false;
    nodeDrag = null;
    canvasElement.classList.remove("dragging-node");
    if (canvasElement.hasPointerCapture(event.pointerId)) {
      canvasElement.releasePointerCapture(event.pointerId);
    }
    if (wasRotating && moved < 3) selectFromPointer(event);
  };
  canvasElement.addEventListener("pointerup", finishPointerInteraction);
  canvasElement.addEventListener("pointercancel", finishPointerInteraction);
  canvasElement.addEventListener("pointerleave", () => {
    if (!nodeDrag && !rotating) canvasElement.classList.remove("over-agent");
  });
  canvasElement.addEventListener("wheel", (event) => {
    event.preventDefault();
    camera.position.z = THREE.MathUtils.clamp(camera.position.z + event.deltaY * 0.008, 7, 20);
    needsRender = true;
  }, { passive: false });

  search?.addEventListener("input", () => {
    const query = search.value.trim().toLowerCase();
    for (const node of nodes.values()) {
      const visible = !query || `${node.agent.name} ${node.agent.id}`.toLowerCase().includes(query);
      node.group.visible = visible;
      node.label.hidden = !visible;
    }
    needsRender = true;
  });
  motionToggle?.addEventListener("click", () => {
    motionEnabled = !motionEnabled;
    motionToggle.setAttribute("aria-pressed", String(motionEnabled));
    motionToggle.textContent = motionEnabled ? "Motion on" : "Motion off";
    needsRender = true;
  });
  reducedMotionQuery.addEventListener("change", (event) => {
    if (event.matches) motionEnabled = false;
  });

  document.querySelector("#topology-add-agent")?.addEventListener("click", () => {
    document.querySelector<HTMLButtonElement>('[data-panel="create"]')?.click();
  });
  const fitView = (): void => {
    world.rotation.set(0, 0, 0);
    camera.position.set(0, 4.8, 12.5);
    camera.lookAt(0, 0, 0);
    needsRender = true;
  };
  document.querySelector("#topology-fit")?.addEventListener("click", fitView);
  document.querySelector("#topology-fit-secondary")?.addEventListener("click", fitView);
  document.querySelector("#topology-zoom-out")?.addEventListener("click", () => {
    camera.position.z = THREE.MathUtils.clamp(camera.position.z + 1.4, 7, 20);
    needsRender = true;
  });

  window.addEventListener("topology:refresh", () => void refreshAgents());
  void refreshAgents();
  try {
    const stream = new EventSource("/api/events/stream");
    stream.addEventListener("agent-event", (message) => {
      const event = JSON.parse((message as MessageEvent).data) as AgentEvent;
      animateEvent(event);
      void refreshAgents();
    });
  } catch {
    // The REST refresh still keeps the topology usable in browsers without EventSource.
  }
  tick();

  async function refreshAgents(): Promise<void> {
    workspaceElement.setAttribute("aria-busy", "true");
    const [response, sensorResponse, routingResponse] = await Promise.all([
      fetch("/api/agents"),
      fetch("/api/sensor-events"),
      fetch("/api/routing"),
    ]);
    if (!response.ok) {
      workspaceElement.setAttribute("aria-busy", "false");
      return;
    }
    const body = await response.json() as { agents?: AgentSnapshot[] };
    const sensorBody = sensorResponse.ok
      ? await sensorResponse.json() as { events?: SensorEventSnapshot[] }
      : { events: [] };
    const routingBody = routingResponse.ok
      ? await routingResponse.json() as { mode?: string }
      : { mode: "explicit" };
    agents = Array.isArray(body.agents) ? body.agents : [];
    sensorEvents = Array.isArray(sensorBody.events) ? sensorBody.events : [];
    routingMode = routingBody.mode ?? "explicit";
    sensorSources = Array.from(new Set(
      sensorEvents
        .map((event) => event.source.trim())
        .filter(Boolean),
    ));
    rebuildScene();
    workspaceElement.setAttribute("aria-busy", "false");
  }

  async function refreshFallback(): Promise<void> {
    const response = await fetch("/api/agents");
    const body = await response.json() as { agents?: AgentSnapshot[] };
    const current = Array.isArray(body.agents) ? body.agents : [];
    if (fallback) {
      fallback.innerHTML = current.length
        ? current.map((agent) => `<button type="button" data-fallback-agent="${escapeHtml(agent.id)}"><strong>${escapeHtml(agent.name)}</strong><span>${escapeHtml(agent.status)}</span></button>`).join("")
        : "<p>No agents yet. Add an agent to begin.</p>";
    }
  }

  function rebuildScene(): void {
    for (const child of [...world.children]) world.remove(child);
    for (const node of nodes.values()) node.label.remove();
    for (const source of sourceNodes.values()) source.label.remove();
    nodes.clear();
    sourceNodes.clear();
    connections.length = 0;

    const configuredRouter = agents.find((agent) => agent.metadata.role === "router");
    const router = routingMode === "explicit" ? undefined : configuredRouter;
    const ordered = router ? [router, ...agents.filter((agent) => agent.id !== router.id)] : agents;
    ordered.forEach((agent, index) => {
      const position = savedPositions.get(agent.id)?.clone()
        ?? nodePosition(agent, index, ordered.length, Boolean(router));
      const node = createNode(agent, position);
      nodes.set(agent.id, node);
      world.add(node.group);
      labelsElement.appendChild(node.label);
    });

    sensorSources.slice(0, 5).forEach((source, index) => {
      const record = createSourceNode(source, index, sensorSources.length);
      sourceNodes.set(source, record);
      world.add(record.group);
      labelsElement.appendChild(record.label);
    });

    for (const [sourceName, source] of sourceNodes) {
      const targetIds = new Set(
        sensorEvents
          .filter((event) => event.source === sourceName && event.targetAgentId)
          .map((event) => event.targetAgentId as string),
      );
      for (const targetId of targetIds) {
        const targetPosition = nodes.get(targetId)?.group.position;
        if (targetPosition) {
          addConnectionPositions(source.group.position, targetPosition, 0x255d73, 0.62);
        }
      }
    }

    if (router) {
      const routerPosition = nodes.get(router.id)?.group.position;
      if (routerPosition) {
        for (const [sourceName, source] of sourceNodes) {
          const hasDirectTarget = sensorEvents.some(
            (event) => event.source === sourceName && event.targetAgentId,
          );
          if (!hasDirectTarget) {
            addConnectionPositions(source.group.position, routerPosition, 0x255d73, 0.62);
          }
        }
      }
      for (const agent of agents) {
        if (agent.id === router.id || agent.metadata.role === "jarvis") continue;
        addConnection(router.id, agent.id, agent.status === "running" ? 0x778dff : 0x303852);
      }
    }
    if (!selectedAgentId || !nodes.has(selectedAgentId)) {
      selectedAgentId = router?.id ?? agents[0]?.id ?? null;
    }
    updateSelection();
    needsRender = true;
  }

  function createSourceNode(source: string, index: number, count: number): SourceRecord {
    const group = new THREE.Group();
    const spread = Math.max(1, Math.min(count, 5));
    const spacing = spread <= 2 ? 3.85 : 1.35;
    group.position.set(-5.15, (index - (spread - 1) / 2) * spacing, -0.4);
    const sphere = new THREE.Mesh(
      new THREE.SphereGeometry(0.34, 28, 18),
      new THREE.MeshPhysicalMaterial({
        color: 0x0d2430,
        metalness: 0.4,
        roughness: 0.28,
        clearcoat: 0.9,
        emissive: 0x32c7e8,
        emissiveIntensity: 0.28,
      }),
    );
    group.add(sphere);
    const ring = new THREE.Mesh(
      new THREE.TorusGeometry(0.53, 0.012, 8, 48),
      new THREE.MeshBasicMaterial({ color: 0x4bdcf4, transparent: true, opacity: 0.7 }),
    );
    ring.rotation.x = Math.PI / 2;
    group.add(ring);
    const label = document.createElement("div");
    label.className = "topology-label topology-source-label";
    label.innerHTML = `<strong>${escapeHtml(source)}</strong><span>event source</span>`;
    return { group, label };
  }

  function createNode(agent: AgentSnapshot, position: THREE.Vector3): NodeRecord {
    const group = new THREE.Group();
    group.position.copy(position);
    const color = statusColor(agent.status);
    const sphere = new THREE.Mesh(
      new THREE.SphereGeometry(agent.metadata.role === "router" ? 0.72 : 0.58, 36, 24),
      new THREE.MeshPhysicalMaterial({
        color: 0x11172b,
        metalness: 0.58,
        roughness: 0.24,
        clearcoat: 0.8,
        clearcoatRoughness: 0.18,
        emissive: color,
        emissiveIntensity: agent.status === "running" ? 0.32 : 0.09,
      }),
    );
    sphere.userData.agentId = agent.id;
    group.add(sphere);

    const halo = new THREE.Mesh(
      new THREE.TorusGeometry(agent.metadata.role === "router" ? 0.93 : 0.78, 0.018, 12, 64),
      new THREE.MeshBasicMaterial({ color, transparent: true, opacity: 0.78 }),
    );
    halo.rotation.x = Math.PI / 2.3;
    group.add(halo);

    const orbit = new THREE.Mesh(
      new THREE.TorusGeometry(agent.metadata.role === "router" ? 1.05 : 0.88, 0.008, 8, 64),
      new THREE.MeshBasicMaterial({ color: 0x7889c8, transparent: true, opacity: 0.35 }),
    );
    orbit.rotation.set(Math.PI / 2.8, 0.35, 0);
    group.add(orbit);

    const label = document.createElement("button");
    label.type = "button";
    label.className = `topology-label status-${agent.status}`;
    label.dataset.agentId = agent.id;
    label.innerHTML = `<strong>${escapeHtml(agent.name)}</strong><span>${escapeHtml(agent.status)}</span>`;
    label.addEventListener("click", () => selectAgent(agent.id));
    return { agent, group, sphere, halo, label };
  }

  function addConnection(fromId: string, toId: string, color: number): void {
    const from = nodes.get(fromId)?.group.position;
    const to = nodes.get(toId)?.group.position;
    if (!from || !to) return;
    addConnectionPositions(from, to, color, 0.48);
  }

  function addConnectionPositions(
    from: THREE.Vector3,
    to: THREE.Vector3,
    color: number,
    opacity: number,
  ): void {
    const geometry = new THREE.BufferGeometry().setFromPoints([from, to]);
    const line = new THREE.Line(
      geometry,
      new THREE.LineBasicMaterial({ color, transparent: true, opacity }),
    );
    line.renderOrder = -1;
    world.add(line);
    connections.push({ line, from, to });
  }

  function updateConnections(): void {
    for (const connection of connections) {
      const positions = connection.line.geometry.getAttribute("position") as THREE.BufferAttribute;
      positions.setXYZ(0, connection.from.x, connection.from.y, connection.from.z);
      positions.setXYZ(1, connection.to.x, connection.to.y, connection.to.z);
      positions.needsUpdate = true;
      connection.line.geometry.computeBoundingSphere();
    }
  }

  function animateEvent(event: AgentEvent): void {
    const router = routingMode === "explicit"
      ? undefined
      : agents.find((agent) => agent.metadata.role === "router");
    const routerPosition = router ? nodes.get(router.id)?.group.position : undefined;
    const source = typeof event.payload.source === "string"
      ? sourceNodes.get(event.payload.source)?.group.position
      : undefined;
    const routedTarget = typeof event.payload.targetAgentId === "string"
      ? nodes.get(event.payload.targetAgentId)?.group.position
      : undefined;
    const from = event.type === "sensor_event_ingested" ? source : routerPosition;
    const target = event.type === "sensor_event_ingested"
      ? routerPosition
      : routedTarget ?? nodes.get(event.agentId)?.group.position;
    if (!target || !from || target.equals(from)) return;
    const color = event.type.includes("approval") ? 0xf5aa42 : event.type.includes("failed") ? 0xff5d72 : 0x67d8ff;
    const mesh = new THREE.Mesh(
      new THREE.SphereGeometry(0.07, 14, 10),
      new THREE.MeshBasicMaterial({ color }),
    );
    world.add(mesh);
    pulses.push({ mesh, from: from.clone(), to: target.clone(), started: performance.now() });
    needsRender = true;
  }

  function selectFromPointer(event: PointerEvent): void {
    const node = nodeFromPointer(event);
    if (node) selectAgent(node.agent.id);
  }

  function nodeFromPointer(event: PointerEvent): NodeRecord | null {
    setRayFromPointer(event);
    const hit = raycaster.intersectObjects(Array.from(nodes.values()).map((node) => node.sphere))[0];
    const agentId = hit?.object.userData.agentId;
    return typeof agentId === "string" ? nodes.get(agentId) ?? null : null;
  }

  function pointerPlaneIntersection(event: PointerEvent, plane: THREE.Plane): THREE.Vector3 | null {
    setRayFromPointer(event);
    return raycaster.ray.intersectPlane(plane, new THREE.Vector3());
  }

  function setRayFromPointer(event: PointerEvent): void {
    const rect = canvasElement.getBoundingClientRect();
    pointer.x = ((event.clientX - rect.left) / rect.width) * 2 - 1;
    pointer.y = -((event.clientY - rect.top) / rect.height) * 2 + 1;
    raycaster.setFromCamera(pointer, camera);
  }

  function selectAgent(agentId: string): void {
    selectedAgentId = agentId;
    updateSelection();
    needsRender = true;
  }

  function updateSelection(): void {
    for (const [id, node] of nodes) {
      const selected = id === selectedAgentId;
      node.label.classList.toggle("selected", selected);
      node.halo.scale.setScalar(selected ? 1.22 : 1);
      node.halo.material.opacity = selected ? 1 : 0.72;
    }
    const agent = agents.find((item) => item.id === selectedAgentId) ?? null;
    renderInspector(agent);
  }

  function renderInspector(agent: AgentSnapshot | null): void {
    if (!agent) {
      inspectorElement.innerHTML = '<div class="topology-inspector-empty"><strong>No agent selected</strong><span>Add or select an agent to inspect it.</span></div>';
      return;
    }
    inspectorElement.innerHTML = `
      <header><div><span class="topology-kicker">Selected agent</span><h2>${escapeHtml(agent.name)}</h2><p><i class="status-dot ${escapeHtml(agent.status)}"></i>${escapeHtml(agent.status)}</p></div><button type="button" data-close-inspector aria-label="Close inspector">×</button></header>
      <section><h3>Current state</h3><dl><div><dt>Role</dt><dd>${escapeHtml(String(agent.metadata.role ?? "worker"))}</dd></div><div><dt>Model</dt><dd>${escapeHtml(agent.model ?? "default")}</dd></div><div><dt>Thread</dt><dd>${escapeHtml(agent.threadId ?? "not started")}</dd></div><div><dt>Workspace</dt><dd>${escapeHtml(agent.cwd)}</dd></div><div><dt>Permissions</dt><dd>${escapeHtml(permissionLabel(agent))}</dd></div></dl></section>
      <section><h3>Runtime</h3><div class="topology-runtime"><span>Context visibility</span><div><i style="width:${agent.status === "running" ? "62" : "18"}%"></i></div><small>${agent.status === "running" ? "Agent is actively processing work" : "Waiting for work"}</small></div></section>
      <section><h3>Permissions</h3><ul class="topology-permissions">${permissionDetails(agent).map((detail) => `<li>${escapeHtml(detail)}</li>`).join("")}</ul></section>
      <footer><button type="button" data-open-conversation>Open conversation</button><button type="button" class="secondary" data-edit-agent>Edit agent</button>${agent.status === "running" ? '<button type="button" class="secondary" data-pause-agent>Pause</button>' : ""}<button type="button" class="danger" data-remove-agent>Remove</button></footer>`;
    inspectorElement.querySelector("[data-close-inspector]")?.addEventListener("click", () => {
      selectedAgentId = null;
      updateSelection();
    });
    inspectorElement.querySelector("[data-open-conversation]")?.addEventListener("click", () => {
      window.dispatchEvent(new CustomEvent("topology:open-agent", { detail: { agentId: agent.id } }));
    });
    inspectorElement.querySelector("[data-edit-agent]")?.addEventListener("click", () => {
      window.dispatchEvent(new CustomEvent("topology:edit-agent", { detail: { agentId: agent.id } }));
    });
    inspectorElement.querySelector("[data-pause-agent]")?.addEventListener("click", () => void pauseAgent(agent));
    inspectorElement.querySelector("[data-remove-agent]")?.addEventListener("click", () => void removeAgent(agent));
  }

  function permissionLabel(agent: AgentSnapshot): string {
    if (agent.sandbox === "danger-full-access" || agent.approvalPolicy === "never") return "Full access";
    if (agent.approvalsReviewer === "auto_review") return "Approve for me";
    return "Ask for approval";
  }

  function permissionDetails(agent: AgentSnapshot): string[] {
    const label = permissionLabel(agent);
    if (label === "Full access") return ["Unrestricted filesystem and network", "Approval prompts disabled", "Tool activity recorded"];
    if (label === "Approve for me") return ["Workspace access", "Automatic risk review", "Tool activity recorded"];
    return ["Workspace access", "Human approval for escalations", "Tool activity recorded"];
  }

  async function pauseAgent(agent: AgentSnapshot): Promise<void> {
    await fetch(`/api/agents/${encodeURIComponent(agent.id)}/cancel`, { method: "POST" });
    await refreshAgents();
  }

  async function removeAgent(agent: AgentSnapshot): Promise<void> {
    if (!window.confirm(`Delete agent ${agent.name}?`)) return;
    const response = await fetch(`/api/agents/${encodeURIComponent(agent.id)}`, { method: "DELETE" });
    if (response.ok) {
      selectedAgentId = null;
      await refreshAgents();
      window.dispatchEvent(new CustomEvent("topology:refresh-main"));
    }
  }

  function tick(): void {
    window.requestAnimationFrame(tick);
    frameCount += 1;
    if (document.hidden) return;
    const now = performance.now();
    let animated = false;
    if (motionEnabled) {
      for (const node of nodes.values()) {
        if (node.agent.status === "running" || node.agent.status === "starting") {
          node.halo.rotation.z += 0.008;
          node.sphere.position.y = Math.sin(now * 0.0014 + node.group.position.x) * 0.035;
          animated = true;
        }
      }
      for (let index = pulses.length - 1; index >= 0; index -= 1) {
        const pulse = pulses[index];
        if (!pulse) continue;
        const progress = (now - pulse.started) / 1250;
        if (progress >= 1) {
          world.remove(pulse.mesh);
          pulses.splice(index, 1);
          continue;
        }
        pulse.mesh.position.lerpVectors(pulse.from, pulse.to, easeInOut(progress));
        animated = true;
      }
    }
    if (needsRender || animated || frameCount % 60 === 0) {
      updateLabels();
      renderer.render(scene, camera);
      needsRender = false;
    }
  }

  function updateLabels(): void {
    const rect = canvasElement.getBoundingClientRect();
    for (const node of nodes.values()) {
      const position = new THREE.Vector3();
      node.group.getWorldPosition(position);
      position.project(camera);
      node.label.style.transform = `translate(-50%, -50%) translate(${(position.x * 0.5 + 0.5) * rect.width}px, ${(-position.y * 0.5 + 0.5) * rect.height + 62}px)`;
      node.label.style.opacity = position.z > 1 ? "0" : "1";
    }
    for (const source of sourceNodes.values()) {
      const position = new THREE.Vector3();
      source.group.getWorldPosition(position);
      position.project(camera);
      source.label.style.transform = `translate(-50%, -50%) translate(${(position.x * 0.5 + 0.5) * rect.width}px, ${(-position.y * 0.5 + 0.5) * rect.height + 62}px)`;
      source.label.style.opacity = position.z > 1 ? "0" : "1";
    }
  }
}

function nodePosition(
  agent: AgentSnapshot,
  index: number,
  count: number,
  routerActive: boolean,
): THREE.Vector3 {
  if (routerActive && agent.metadata.role === "router") return new THREE.Vector3(0, 0, 0);
  if (agent.metadata.role === "jarvis") return new THREE.Vector3(0, 2.6, -0.7);
  const workerIndex = routerActive ? Math.max(0, index - 1) : index;
  const workerCount = Math.max(1, routerActive ? count - 1 : count);
  const angle = (workerIndex / workerCount) * Math.PI * 2 - Math.PI / 2;
  const radius = 3.7 + (workerIndex % 2) * 0.45;
  return new THREE.Vector3(Math.cos(angle) * radius, Math.sin(angle) * 2.35, Math.sin(angle) * 0.45);
}

function loadSavedPositions(): Map<string, THREE.Vector3> {
  const positions = new Map<string, THREE.Vector3>();
  try {
    const raw = window.localStorage.getItem(TOPOLOGY_LAYOUT_KEY);
    if (!raw) return positions;
    const parsed = JSON.parse(raw) as Record<string, unknown>;
    for (const [agentId, value] of Object.entries(parsed)) {
      if (!Array.isArray(value) || value.length !== 3) continue;
      const coordinates = value.map(Number);
      if (coordinates.every(Number.isFinite)) {
        positions.set(agentId, new THREE.Vector3(coordinates[0], coordinates[1], coordinates[2]));
      }
    }
  } catch {
    // A corrupt or unavailable local store should not prevent the topology from rendering.
  }
  return positions;
}

function savePositions(positions: Map<string, THREE.Vector3>): void {
  try {
    window.localStorage.setItem(TOPOLOGY_LAYOUT_KEY, JSON.stringify(Object.fromEntries(
      Array.from(positions, ([agentId, position]) => [agentId, position.toArray()]),
    )));
  } catch {
    // Dragging remains available for this session when storage is unavailable.
  }
}

function statusColor(status: AgentStatus): number {
  if (status === "running" || status === "starting") return 0x54e59a;
  if (status === "failed") return 0xff5d72;
  if (status === "blocked") return 0xf5aa42;
  if (status === "stopped") return 0x5d6475;
  return 0x7180a4;
}

function easeInOut(value: number): number {
  return value < 0.5 ? 2 * value * value : 1 - Math.pow(-2 * value + 2, 2) / 2;
}

function escapeHtml(value: string): string {
  return String(value).replace(/[&<>"']/g, (char) => ({
    "&": "&amp;",
    "<": "&lt;",
    ">": "&gt;",
    '"': "&quot;",
    "'": "&#39;",
  })[char] ?? char);
}
