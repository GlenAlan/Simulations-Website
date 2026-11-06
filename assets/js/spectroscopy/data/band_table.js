// FOUNDATION STUB, replaced by the bands track: how strongly each object shows in each band (spec section 5).
// The data track calls bandStrengths(body) for every body once its other fields are set, and stores the result as
// body.bands = { radio, ir, visible, uv, xray }, each 0..1. Must be a pure function of the body's fields.

export function bandStrengths(body) {
    return body.bands;
}
