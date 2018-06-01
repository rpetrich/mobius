/** */
/* mobius:shared */
import { EventArgs } from "dom-types";
import { AnimationEventArgs, ClipboardEventArgs, CompositionEventArgs, DragEventArgs, EventArgs as isEventArgs, FocusEventArgs, KeyboardEventArgs, MouseEventArgs, PointerEventArgs, TouchEventArgs, TransitionEventArgs, UIEventArgs, WheelEventArgs } from "dom-types!validators";
import { Channel } from "mobius-types";

export type PreactNode = Element & {
	_listeners?: { [ event: string ]: (event: any, clientID?: number) => void },
	__c?: { [ event: string ]: [Channel, (event: any, clientID?: number) => void] },
};

const eventValidators: { [name: string]: (args: any[]) => args is EventArgs } = {
	// Clipboard Events
	copy: ClipboardEventArgs,
	cut: ClipboardEventArgs,
	paste: ClipboardEventArgs,

	// Composition Events
	compositionend: CompositionEventArgs,
	compositionstart: CompositionEventArgs,
	compositionupdate: CompositionEventArgs,

	// Focus Events
	focus: FocusEventArgs,
	blur: FocusEventArgs,

	// Keyboard Events
	keydown: KeyboardEventArgs,
	keypress: KeyboardEventArgs,
	keyup: KeyboardEventArgs,

	// MouseEvents
	click: MouseEventArgs,
	contextmenu: MouseEventArgs,
	dblclick: MouseEventArgs,
	drag: DragEventArgs,
	dragend: DragEventArgs,
	dragenter: DragEventArgs,
	dragexit: DragEventArgs,
	dragleave: DragEventArgs,
	dragover: DragEventArgs,
	dragstart: DragEventArgs,
	drop: DragEventArgs,
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

	// UI Events
	scroll: UIEventArgs,

	// Wheel Events
	wheel: WheelEventArgs,

	// Animation Events
	animationstart: AnimationEventArgs,
	animationend: AnimationEventArgs,
	animationiteration: AnimationEventArgs,

	// Transition Events
	transitionend: TransitionEventArgs,
};

export function validatorForEventName(key: string): (args: any[]) => args is EventArgs {
	return Object.hasOwnProperty.call(eventValidators, key) ? eventValidators[key as keyof typeof eventValidators] : isEventArgs;
}

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

export function ignoreEvent() {
	/* tslint:disable no-empty */
}
