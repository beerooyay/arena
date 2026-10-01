import * as THREE from 'three';
import * as CANNON from '../vendor/cannon/cannon.js';

export const gravity = -9.80665 * 0.95;
const world = new CANNON.World({ gravity: new CANNON.Vec3(0, gravity, 0), allowSleep: true });
world.broadphase = new CANNON.SAPBroadphase(world);
world.solver.iterations = 24;
world.solver.tolerance = 0.001;
world.defaultContactMaterial.friction = 0.55;
world.defaultContactMaterial.restitution = 0;
world.defaultContactMaterial.contactEquationStiffness = 2e6;
world.defaultContactMaterial.contactEquationRelaxation = 6;
const dolls = new Set();
const owners = new WeakMap();
let landing = null;
export function impacts(callback) { landing = callback; }
const terrain = [];
const point = new THREE.Vector3();
const rotation = new THREE.Quaternion(), parent = new THREE.Quaternion(), bodyQuat = new THREE.Quaternion();
const vector = (value) => new CANNON.Vec3(value.x, value.y, value.z);
const quaternion = (value) => new CANNON.Quaternion(value.x, value.y, value.z, value.w);
const parts = [
  ['Hips', 'Spine', 12, 0.18, 0.13],
  ['Spine', 'Spine2', 18, 0.21, 0.15],
  ['Spine2', 'Neck', 12, 0.21, 0.15],
  ['Head', 'HeadTop_End', 5, 0.14, 0.14],
];
for (const side of ['Left', 'Right']) parts.push(
  [side + 'Arm', side + 'ForeArm', 3, 0.08, 0.08],
  [side + 'ForeArm', side + 'Hand', 2, 0.075, 0.075],
  [side + 'UpLeg', side + 'Leg', 8, 0.11, 0.11],
  [side + 'Leg', side + 'Foot', 5, 0.095, 0.095],
  [side + 'Foot', side + 'ToeBase', 2, 0.1, 0.07],
);

export function configure(arena) {
  for (const doll of [...dolls]) doll.dispose();
  for (const body of terrain) world.removeBody(body);
  terrain.length = 0;
  const add = (shape, position, orientation = new THREE.Quaternion()) => {
    const body = new CANNON.Body({ mass: 0, collisionFilterGroup: 1, collisionFilterMask: -2,
      position: vector(position), quaternion: quaternion(orientation) });
    body.addShape(shape); world.addBody(body); terrain.push(body);
  };
  add(new CANNON.Plane(), new THREE.Vector3(), new THREE.Quaternion().setFromAxisAngle(new THREE.Vector3(1, 0, 0), -Math.PI / 2));
  arena.group.updateMatrixWorld(true);
  for (const mesh of arena.losBlockers) {
    if (mesh.name === 'floor') continue;
    const geometry = mesh.geometry, size = geometry.parameters;
    const position = mesh.getWorldPosition(new THREE.Vector3());
    const orientation = mesh.getWorldQuaternion(new THREE.Quaternion());
    const scale = mesh.getWorldScale(new THREE.Vector3());
    if (geometry.type === 'BoxGeometry' && size.height > 3 && size.width > arena.size * 0.35 && size.depth > 0.15) {
      add(new CANNON.Box(new CANNON.Vec3(size.width * scale.x / 2, size.height * scale.y / 2, size.depth * scale.z / 2)), position, orientation);
    } else if (geometry.type === 'CylinderGeometry' && mesh.userData.blocker) {
      add(new CANNON.Cylinder(size.radiusTop * scale.x, size.radiusBottom * scale.x, size.height * scale.y, 16), position, orientation);
    } else if (mesh.userData.blocker) {
      geometry.computeBoundingBox();
      const box = geometry.boundingBox;
      const half = box.getSize(new THREE.Vector3()).multiply(scale).multiplyScalar(0.5);
      add(new CANNON.Box(vector(half)), box.getCenter(new THREE.Vector3()).applyMatrix4(mesh.matrixWorld), orientation);
    }
  }
}

export class Ragdoll {
  constructor(model, impact = null, velocity = null) {
    this.model = model;
    this.nodes = [];
    this.joints = [];
    this.pose = [];
    this.disposed = false; this.elapsed = 0; this.quiet = 0; this.landed = false;
    this.group = 2;
    while ([...dolls].some((doll) => doll.group === this.group)) this.group <<= 1;
    model.updateWorldMatrix(true, true);
    model.traverse((bone) => { if (bone.isBone) this.pose.push({ bone, position: bone.position.clone(), rotation: bone.quaternion.clone() }); });
    const mapped = new Map();
    for (const [name, end, mass, width, depth] of parts) {
      const bone = model.getObjectByName('mixamorig' + name), child = model.getObjectByName('mixamorig' + end);
      if (!bone || !child) continue;
      const start = bone.getWorldPosition(new THREE.Vector3()), finish = child.getWorldPosition(new THREE.Vector3());
      const orientation = bone.getWorldQuaternion(new THREE.Quaternion());
      const center = start.clone().lerp(finish, 0.5);
      const shift = center.clone().sub(start).applyQuaternion(orientation.clone().invert());
      const axis = finish.clone().sub(start).normalize().applyQuaternion(orientation.clone().invert());
      const body = new CANNON.Body({ mass, position: vector(center), quaternion: quaternion(orientation),
        linearDamping: 0.3, angularDamping: 0.65, allowSleep: true, sleepSpeedLimit: 0.22, sleepTimeLimit: 0.7,
        collisionFilterGroup: this.group, collisionFilterMask: ~this.group });
      if (name === 'Head') body.addShape(new CANNON.Sphere(width));
      else body.addShape(new CANNON.Box(new CANNON.Vec3(width, Math.max(start.distanceTo(finish) / 2, 0.065), depth)),
        new CANNON.Vec3(), quaternion(new THREE.Quaternion().setFromUnitVectors(new THREE.Vector3(0, 1, 0), axis)));
      if (velocity) body.velocity.copy(vector(velocity.clone().multiplyScalar(0.45).clampLength(0, 6)));
      body.addEventListener('collide', (event) => {
        const speed = Math.abs(event.contact.getImpactVelocityAlongNormal());
        if (this.landed || this.elapsed < 0.1 || speed < 1 || event.body.mass !== 0) return;
        this.landed = true;
        landing?.(new THREE.Vector3().copy(body.position), speed);
      });
      world.addBody(body); owners.set(body, this);
      const node = { bone, body, shift, start, orientation: orientation.clone(), local: bone.position.clone(), axis: finish.sub(start).normalize() };
      mapped.set(bone, node); this.nodes.push(node);
    }
    for (const node of this.nodes) {
      let ancestor = node.bone.parent;
      while (ancestor && !mapped.has(ancestor)) ancestor = ancestor.parent;
      const previous = mapped.get(ancestor);
      if (!previous) continue;
      const anchor = vector(node.start), axis = vector(node.axis);
      const pivotA = previous.body.pointToLocalFrame(anchor), pivotB = node.body.pointToLocalFrame(anchor);
      const axisA = previous.body.vectorToLocalFrame(axis), axisB = node.body.vectorToLocalFrame(axis);
      const name = node.bone.name;
      const angle = /ForeArm|mixamorig(Left|Right)Leg$/.test(name) ? 1.5 : /Arm/.test(name) ? 1.4 : /UpLeg/.test(name) ? 1 : 0.45;
      const joint = new CANNON.ConeTwistConstraint(previous.body, node.body, {
        pivotA, pivotB, axisA, axisB, angle, twistAngle: /ForeArm|mixamorig(Left|Right)Leg$/.test(name) ? 0.12 : 0.35,
        maxForce: 20000, collideConnected: false,
      });
      const tangent = new THREE.Vector3().crossVectors(node.axis, new THREE.Vector3(1, 0, 0));
      if (tangent.lengthSq() < 1e-6) tangent.crossVectors(node.axis, new THREE.Vector3(0, 0, 1));
      tangent.normalize();
      const tangentA = previous.body.vectorToLocalFrame(vector(tangent)), tangentB = node.body.vectorToLocalFrame(vector(tangent));
      const update = joint.update.bind(joint);
      joint.update = () => {
        update();
        previous.body.vectorToWorldFrame(tangentA, joint.twistEquation.axisA);
        node.body.vectorToWorldFrame(tangentB, joint.twistEquation.axisB);
      };
      for (const equation of joint.equations) equation.setSpookParams(2e6, 6, 1 / 120);
      world.addConstraint(joint); this.joints.push(joint);
    }
    dolls.add(this);
    const direction = impact?.direction?.clone() || new THREE.Vector3(0, 0.05, -1).applyQuaternion(model.parent.quaternion);
    direction.normalize();
    const strength = impact?.blast ? 22 : 7;
    for (const { body } of this.nodes) {
      body.velocity.x += direction.x * (impact?.blast ? 1.4 : 0.35);
      body.velocity.z += direction.z * (impact?.blast ? 1.4 : 0.35);
      if (impact?.blast) body.velocity.y += 0.8;
    }
    const hit = impact?.point || this.nodes.find((node) => /Spine2/.test(node.bone.name)).start;
    let closest = this.nodes[0], distance = Infinity;
    for (const node of this.nodes) {
      const current = new THREE.Vector3().copy(node.body.position).distanceToSquared(hit);
      if (current < distance) { closest = node; distance = current; }
    }
    closest.body.applyImpulse(vector(direction.multiplyScalar(strength)), vector(new THREE.Vector3().copy(hit).sub(closest.body.position).clampLength(0, 0.35)));
    this.sync();
  }

  sync(dt = 0) {
    if (this.disposed) return;
    this.elapsed += dt;
    const blend = THREE.MathUtils.smoothstep(this.elapsed, 0, 0.18);
    for (const { bone, body, shift, start, orientation, local } of this.nodes) {
      // interpolatedQuaternion is a CANNON quat — copy fields into a THREE quat:
      // THREE's slerp reads private _x.._w, which don't exist on cannon objects
      bodyQuat.set(body.interpolatedQuaternion.x, body.interpolatedQuaternion.y,
        body.interpolatedQuaternion.z, body.interpolatedQuaternion.w);
      rotation.copy(orientation).slerp(bodyQuat, blend);
      if (!(rotation.lengthSq() > 0.5)) continue; // never write a bad pose
      bone.parent.updateWorldMatrix(true, false);
      if (bone.name === 'mixamorigHips') {
        point.copy(shift).applyQuaternion(rotation).negate().add(body.interpolatedPosition);
        point.lerp(start, 1 - blend);
        bone.position.copy(bone.parent.worldToLocal(point));
      } else bone.position.copy(local);
      bone.parent.getWorldQuaternion(parent);
      bone.quaternion.copy(parent.invert().multiply(rotation));
    }
  }

  dispose() {
    if (this.disposed) return;
    for (const joint of this.joints) world.removeConstraint(joint);
    for (const { body } of this.nodes) { world.removeBody(body); owners.delete(body); }
    for (const { bone, position, rotation } of this.pose) { bone.position.copy(position); bone.quaternion.copy(rotation); }
    this.disposed = true; dolls.delete(this);
  }
}

export function step(dt) {
  let awake = false;
  for (const doll of dolls) if (doll.nodes.some(({ body }) => body.sleepState !== CANNON.Body.SLEEPING)) { awake = true; break; }
  if (!awake) return;
  world.step(1 / 120, Math.min(dt, 0.05), 6);
  for (const doll of dolls) {
    doll.sync(Math.min(dt, 0.05));
    let energy = 0, speed = 0;
    for (const { body } of doll.nodes) {
      if (doll.elapsed > 1.2) { body.angularDamping = 0.9; body.linearDamping = 0.4; }
      speed = Math.max(speed, body.velocity.length());
      energy += body.mass * body.velocity.lengthSquared() + (body.inertia.x + body.inertia.y + body.inertia.z) / 3 * body.angularVelocity.lengthSquared();
    }
    const supported = doll.landed && doll.elapsed > 2.2 && doll.nodes[0].body.velocity.length() < 0.25;
    doll.quiet = supported || doll.elapsed > 1.4 && speed < 0.35 && energy < 2 ? doll.quiet + dt : 0;
    if (doll.quiet > 0.25) for (const { body } of doll.nodes) { body.velocity.setZero(); body.angularVelocity.setZero(); body.sleep(); }
  }
}

const contact = new CANNON.RaycastResult(), blocker = new CANNON.RaycastResult();
export function trace(origin, direction, distance) {
  if (!dolls.size) return null;
  contact.reset();
  const end = new THREE.Vector3().copy(origin).addScaledVector(direction, distance);
  if (!world.raycastClosest(vector(origin), vector(end), { collisionFilterGroup: 1, collisionFilterMask: -2 }, contact)) return null;
  return { body: contact.body, point: new THREE.Vector3().copy(contact.hitPointWorld), distance: contact.distance };
}

export function shove(hit, direction, force = 4) {
  const doll = owners.get(hit.body);
  if (doll) doll.quiet = 0;
  for (const { body } of doll?.nodes || [{ body: hit.body }]) body.wakeUp();
  hit.body.applyImpulse(vector(direction.clone().multiplyScalar(force)), vector(hit.point.clone().sub(hit.body.position).clampLength(0, 0.35)));
}

export function wave(origin, radius) {
  for (const doll of dolls) for (const { body } of doll.nodes) {
    const direction = new THREE.Vector3().copy(body.position).sub(origin), distance = direction.length();
    if (distance >= radius) continue;
    blocker.reset();
    if (world.raycastClosest(vector(origin), body.position, { collisionFilterGroup: -2, collisionFilterMask: 1 }, blocker)) continue;
    direction.normalize(); direction.y = Math.max(0.2, direction.y);
    shove({ body, point: new THREE.Vector3().copy(body.position) }, direction, body.mass * 0.9 * (1 - distance / radius));
  }
}

export function stats() { return { dolls: dolls.size, bodies: world.bodies.length - terrain.length, joints: world.constraints.length }; }
