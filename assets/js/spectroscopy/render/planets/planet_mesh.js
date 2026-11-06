// FOUNDATION STUB, replaced by the planets track: builds a planet from its data and its host's temperature.
// createPlanetMesh returns { object3d, update(frame, sunDirWorld), dispose() } with radius 1, so the caller
// scales it to suit. Composition and physics decide the look; the seed only varies the pattern (spec 6.4).

import * as THREE from 'three';

export function createPlanetMesh(planet, hostTeffK, opts = {}) {
    const material = new THREE.MeshBasicMaterial({ color: 0x8899aa });
    const mesh = new THREE.Mesh(new THREE.SphereGeometry(1, 48, 32), material);
    return {
        object3d: mesh,
        update(frame, sunDirWorld) {},
        dispose() {
            mesh.geometry.dispose();
            material.dispose();
        }
    };
}
