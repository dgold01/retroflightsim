import * as THREE from 'three';
import { PITCH_RATE, PLANE_DISTANCE_TO_GROUND, ROLL_RATE, TERRAIN_MODEL_SIZE, TERRAIN_SCALE, YAW_RATE } from "../../defs";
import { FORWARD, RIGHT, UP, ZERO } from '../../scene/scene';
import { clamp, easeOutCirc, isZero, roundToZero } from "../../utils/math";
import { FlightModel } from './flightModel';

const TURNING_RATE = Math.PI * 1.5; // Radians/second
const STALL_RATE = Math.PI / 6; // Radians/second
const INDUCED_DRAG_FACTOR = 10.0; // Unitless
const ROLL_DRAG_FACTOR = 0.05; // Unitless
const GROUND_FRICTION_KINETIC = 0.15; // Unitless
const GROUND_FRICTION_STATIC = 0.3; // Unitless

const MAX_THRUST = 20; // m/s^2
const DRY_MASS: number = 20000; // kg
const WING_AREA: number = 78; // m^2
const GROUND_AIR_DENSITY: number = 1.225; // kg/m^3
const GRAVITY: number = 9.8; // m/s^2
const CD: number = 0.15; // Unitless

export class ArcadeFlightModel extends FlightModel {

    private stall: number = 0;

    private _v: THREE.Vector3 = new THREE.Vector3();
    private _q0: THREE.Quaternion = new THREE.Quaternion();
    private _q1: THREE.Quaternion = new THREE.Quaternion();
    private _m: THREE.Matrix4 = new THREE.Matrix4();

    private drag: THREE.Vector3 = new THREE.Vector3(); // N
    private thrust: THREE.Vector3 = new THREE.Vector3(); // N
    private weight: THREE.Vector3 = new THREE.Vector3(); // N
    private friction: THREE.Vector3 = new THREE.Vector3(); // N
    private forces: THREE.Vector3 = new THREE.Vector3(); // N

    private forward: THREE.Vector3 = new THREE.Vector3();
    private up: THREE.Vector3 = new THREE.Vector3();
    private right: THREE.Vector3 = new THREE.Vector3();

    private prjForward: THREE.Vector3 = new THREE.Vector3();
    private velocityUnit: THREE.Vector3 = new THREE.Vector3();

    step(delta: number): void {

        this.forward = this.forward.copy(FORWARD).applyQuaternion(this.obj.quaternion);
        this.up = this.up.copy(UP).applyQuaternion(this.obj.quaternion);
        this.right = this.right.copy(RIGHT).applyQuaternion(this.obj.quaternion);

        this.prjForward = this.prjForward.copy(this.forward).setY(0);
        this.velocityUnit = this.velocityUnit.copy(this.velocity).normalize();

        const airDensity: number = GROUND_AIR_DENSITY * Math.exp(-this.obj.position.y / 8000); // kg/m^3
        const speed = this.velocity.length(); // m/s

        const rightPrjVelocity = this._v.copy(this.velocityUnit).projectOnPlane(this.right);
        const aoaAngle = rightPrjVelocity.angleTo(this.forward);
        const aoaSign = rightPrjVelocity.cross(this.forward).dot(this.right) > 0 ? -1 : 1;
        const aoa = aoaSign * aoaAngle;


        // Roll control
        if (!isZero(this.roll) && !this.landed) {
            this.obj.rotateZ(this.roll * ROLL_RATE * delta);
        }

        // Pitch control
        if (!isZero(this.pitch)
            && !(this.landed && this.pitch < 0) // Can't pitch down when landed
            && (
                this.stall < 0 || // Can do anything when flying and no stalling
                (this.pitch < 0 && this.up.y > 0) || // Can't pitch up when stalling
                (this.pitch > 0 && this.up.y < 0) // Can't pitch up when stalling
            )
        ) {
            this.obj.rotateX(-this.pitch * PITCH_RATE * delta);
        }

        // Yaw control
        if (!isZero(this.yaw) && !isZero(speed)) {
            this.obj.rotateY(-this.yaw * YAW_RATE * delta);
        }

        // Automatic yaw when rolling
        if (-0.99 < this.forward.y && this.forward.y < 0.99) {
            const prjUp = this._v.copy(this.up).projectOnPlane(this.prjForward).setY(0);
            const sign = (this.prjForward.x * prjUp.z - this.prjForward.z * prjUp.x) > 0 ? -1 : 1;
            this.obj.rotateOnWorldAxis(UP, sign * prjUp.length() * prjUp.length() * this.prjForward.length() * 2.0 * YAW_RATE * delta);
        }

        // Point down when stalling
        if (this.stall >= 0 && !this.landed) {
            const y = this.forward.y;
            if (y > -0.8) {
                const groundRight = this._v.copy(this.forward).cross(this.prjForward).normalize();
                this.obj.rotateOnWorldAxis(groundRight, STALL_RATE * delta * (y > 0 ? 1 : -1));
            }
        }

        //! THRUST
        roundToZero(this.thrust.copy(this.forward).multiplyScalar(airDensity * MAX_THRUST * this.throttle * DRY_MASS));

        //! DRAG
        const arcadeInducedDrag = this.forward.dot(this.velocityUnit);
        const liftInducedDrag = 1 - Math.cos(2.0 * aoa);
        const rollDrag = Math.abs(this.right.y);
        roundToZero(this.drag
            .copy(this.velocityUnit)
            .negate()
            .multiplyScalar(
                Math.pow(
                    0.5 * (CD + liftInducedDrag) * airDensity * speed * speed * WING_AREA,
                    1.0 + INDUCED_DRAG_FACTOR * (1.0 - arcadeInducedDrag) + ROLL_DRAG_FACTOR * rollDrag
                )
            )
        );

        //! LIFT
        const aoaLift = 0.2 * (aoa < (Math.PI / 8.0) || aoa > (7 * Math.PI / 8.0) ? Math.sin(6.0 * aoa) : Math.sin(2.0 * aoa));
        const minLiftFactor = 2.0 * (0.75 * 0.75 + 0.75) * GROUND_AIR_DENSITY;
        const fwdY = this.forward.y;
        const rightY = Math.abs(this.right.y);
        const liftFactor = 2 * (speed / 256.0) * ((-0.5 * fwdY + 1.5) * (-0.5 * rightY + 1.5) + (-0.5 * rightY + 1.5)) * airDensity;
        this.stall = -clamp(liftFactor / minLiftFactor + aoaLift * (1.0 - rightY) - 1.0, -1.0, 1.0);

        //! WEIGHT
        const weightFwdFactor = -this.forward.y;
        // Accounts for lift. 500 knots -> 256 m/s
        const weightDownFactor = -easeOutCirc(1.0 - clamp((speed / 256) * (1.0 - Math.abs(this.forward.y) * (1.0 - Math.abs(this.right.y))), 0, 1));
        this.weight
            .copy(UP)
            .multiplyScalar(weightDownFactor)
            .addScaledVector(this.forward, weightFwdFactor)
            .multiplyScalar(DRY_MASS * GRAVITY);

        //! Magic velocity rotation
        if (!isZero(speed)) {
            if (this.landed) {
                this.velocity.copy(this.forward).multiplyScalar(speed);
            } else {
                const alpha = this.velocityUnit.angleTo(this.forward);
                const turningFactor = alpha * TURNING_RATE * delta;
                this._m.lookAt(ZERO, this.forward, this.up);
                this._q1 = new THREE.Quaternion().setFromRotationMatrix(this._m);
                this._m.lookAt(ZERO, this.velocityUnit, this.up);
                this._q0 = new THREE.Quaternion().setFromRotationMatrix(this._m);
                this._q0.rotateTowards(this._q1, turningFactor);
                this._q1.setFromRotationMatrix(this._m.invert());
                this._v.copy(this.velocityUnit)
                    .applyQuaternion(this._q1)
                    .applyQuaternion(this._q0);
                this.velocity.copy(this._v).multiplyScalar(speed);
            }
        }

        //! All forces
        this.forces.set(0, 0, 0).add(this.thrust).add(this.drag).add(this.weight);

        //! FRICTION
        if (this.landed) {
            const weightMagnitude = DRY_MASS * GRAVITY;
            const prjForces = this._v.copy(this.forces).setY(0);
            const prjForcesMagnitude = prjForces.length();
            const maxStaticFriction = GROUND_FRICTION_STATIC * weightMagnitude;
            const kineticFriction = GROUND_FRICTION_KINETIC * weightMagnitude;

            if ((isZero(speed) && prjForcesMagnitude < maxStaticFriction)) {
                this.friction.copy(prjForces).negate();
            } else {
                this.friction.copy(this.velocityUnit).setY(0).negate().normalize().multiplyScalar(kineticFriction);
            }
            roundToZero(this.friction);
        } else {
            this.friction.set(0, 0, 0);
        }

        //! Timestep
        const accel = roundToZero(this.forces.add(this.friction).divideScalar(DRY_MASS));
        this.velocity.addScaledVector(accel, delta);
        if (this.landed && this.velocity.y < 0) {
            this.velocity.setY(0);
        }

        //! Apply
        this.obj.position.addScaledVector(roundToZero(this.velocity, this.throttle > 0 ? 0.01 : 0.1), delta);
        if (this.obj.position.y > PLANE_DISTANCE_TO_GROUND) {
            this.landed = false;
        }


        // Avoid ground crashes
        if (this.obj.position.y < PLANE_DISTANCE_TO_GROUND) {
            this.obj.position.y = PLANE_DISTANCE_TO_GROUND;
            const d = this.obj.getWorldDirection(this._v);
            if (d.y < 0.0) {
                d.setY(0).add(this.obj.position);
                this.obj.lookAt(d);
            }
            this.velocity.setY(0);
            this.stall = -1;
            this.landed = true;
        }

        // Avoid flying out of bounds, wraps around
        const terrainHalfSize = 2.5 * TERRAIN_SCALE * TERRAIN_MODEL_SIZE;
        if (this.obj.position.x > terrainHalfSize) this.obj.position.x = -terrainHalfSize;
        if (this.obj.position.x < -terrainHalfSize) this.obj.position.x = terrainHalfSize;
        if (this.obj.position.z > terrainHalfSize) this.obj.position.z = -terrainHalfSize;
        if (this.obj.position.z < -terrainHalfSize) this.obj.position.z = terrainHalfSize;
    }

    getStallStatus(): number {
        return this.stall;
    }
}