/** */
/* mobius:shared */
import { EventArgs } from "dom-types";
import { AnimationEventArgs, ClipboardEventArgs, CompositionEventArgs, DragEventArgs, EventArgs as isEventArgs, FocusEventArgs, KeyboardEventArgs, MouseEventArgs, PointerEventArgs, TouchEventArgs, TransitionEventArgs, UIEventArgs, WheelEventArgs } from "dom-types!validators";
import { Channel } from "mobius-types";

/** @ignore */
export type PreactNode = Element & {
	_listeners?: { [ event: string ]: (event: any, clientID?: number) => void },
	__c?: { [ event: string ]: [Channel, (event: any, clientID?: number) => void] },
};

const eventValidators: { [name: string]: (args: any[]) => args is EventArgs } = {

	// Keyboard Events
	keydown: KeyboardEventArgs,
	keypress: KeyboardEventArgs,
	keyup: KeyboardEventArgs,

	// Mouse Events
	click: MouseEventArgs,
	contextmenu: MouseEventArgs,
	dblclick: MouseEventArgs,
	drag: MouseEventArgs,
	dragend: MouseEventArgs,
	dragenter: MouseEventArgs,
	dragexit: MouseEventArgs,
	dragleave: MouseEventArgs,
	dragover: MouseEventArgs,
	dragstart: MouseEventArgs,
	drop: MouseEventArgs,
	mousedown: MouseEventArgs,
	mouseenter: MouseEventArgs,
	mouseleave: MouseEventArgs,
	mousemove: MouseEventArgs,
	mouseout: MouseEventArgs,
	mouseover: MouseEventArgs,
	mouseup: MouseEventArgs,

	// Touch Events
	touchcancel: TouchEventArgs,
	touchend: TouchEventArgs,
	touchmove: TouchEventArgs,
	touchstart: TouchEventArgs,

	// Pointer Events
	pointerover: PointerEventArgs,
	pointerenter: PointerEventArgs,
	pointerdown: PointerEventArgs,
	pointermove: PointerEventArgs,
	pointerup: PointerEventArgs,
	pointercancel: PointerEventArgs,
	pointerout: PointerEventArgs,
	pointerleave: PointerEventArgs,

	// Animation Events
	animationstart: AnimationEventArgs,
	animationend: AnimationEventArgs,
	animationiteration: AnimationEventArgs,

	// Transition Events
	transitionend: TransitionEventArgs,
};

/** @ignore */
export function validatorForEventName(key: string): (args: any[]) => args is EventArgs {
	return Object.hasOwnProperty.call(eventValidators, key) ? eventValidators[key as keyof typeof eventValidators] : isEventArgs;
}

/** @ignore */
export function nodeRemovedHook(node: PreactNode) {
	const c = node.__c;
	if (c) {
		for (const name in c) {
			if (Object.hasOwnProperty.call(c, name)) {
				c[name][0].close();
				delete c[name];
			}
		}
	}
}

/** @ignore */
export function ignoreEvent() {
	/* tslint:disable no-empty */
}
