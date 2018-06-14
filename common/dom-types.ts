/** */
/* mobius:shared */

/** @ignore */
export const defaultEventProperties = {
	altKey: false,
	bubbles: true,
	button: 0,
	buttons: 0,
	cancelBubble: false,
	cancelable: true,
	composed: true,
	ctrlKey: false,
	metaKey: false,
	shiftKey: false,
	repeat: false,
	returnValue: true,
	defaultPrevented: false,
	movementX: 0,
	movementY: 0,
	type: "click",
	which: 1,
	eventPhase: 2,
	isTrusted: true,
	detail: 1,
};

/** @ignore */
export type EventArgs = [JSX.Event];
/** @ignore */
export type KeyboardEventArgs = [JSX.KeyboardEvent];
/** @ignore */
export type MouseEventArgs = [JSX.MouseEvent];
/** @ignore */
export type TouchEventArgs = [JSX.TouchEvent];
/** @ignore */
export type AnimationEventArgs = [JSX.AnimationEvent];
/** @ignore */
export type TransitionEventArgs = [JSX.TransitionEvent];
/** @ignore */
export type PointerEventArgs = [JSX.PointerEvent];
