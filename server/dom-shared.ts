import { Event } from "dom-types";
import { AnimationEvent as isAnimationEvent, Event as isEvent, KeyboardEvent as isKeyboardEvent, MouseEvent as isMouseEvent, PointerEvent as isPointerEvent, TouchEvent as isTouchEvent, TransitionEvent as isTransitionEvent } from "dom-types!validators";
import { Channel } from "mobius-types";
import { Component } from "preact";

/** @ignore */
export type PreactElement = Element & {
	_component?: Component<never, never>;
	_listeners?: { [ event: string ]: (event: any, clientID?: number) => void | PromiseLike<void> },
	__c?: { [ event: string ]: [Channel, (event: any, clientID?: number) => void | PromiseLike<void>] },
};

const eventValidators: { [name: string]: (event: unknown) => event is Event } = {

	// Keyboard Events
	keydown: isKeyboardEvent,
	keypress: isKeyboardEvent,
	keyup: isKeyboardEvent,

	// Mouse Events
	click: isMouseEvent,
	contextmenu: isMouseEvent,
	dblclick: isMouseEvent,
	drag: isMouseEvent,
	dragend: isMouseEvent,
	dragenter: isMouseEvent,
	dragexit: isMouseEvent,
	dragleave: isMouseEvent,
	dragover: isMouseEvent,
	dragstart: isMouseEvent,
	drop: isMouseEvent,
	mousedown: isMouseEvent,
	mouseenter: isMouseEvent,
	mouseleave: isMouseEvent,
	mousemove: isMouseEvent,
	mouseout: isMouseEvent,
	mouseover: isMouseEvent,
	mouseup: isMouseEvent,

	// Touch Events
	touchcancel: isTouchEvent,
	touchend: isTouchEvent,
	touchmove: isTouchEvent,
	touchstart: isTouchEvent,

	// Pointer Events
	pointerover: isPointerEvent,
	pointerenter: isPointerEvent,
	pointerdown: isPointerEvent,
	pointermove: isPointerEvent,
	pointerup: isPointerEvent,
	pointercancel: isPointerEvent,
	pointerout: isPointerEvent,
	pointerleave: isPointerEvent,

	// Animation Events
	animationstart: isAnimationEvent,
	animationend: isAnimationEvent,
	animationiteration: isAnimationEvent,

	// Transition Events
	transitionend: isTransitionEvent,
};

/** @ignore */
export function validatorForEventName(key: string): (event: unknown) => event is Event {
	return Object.hasOwnProperty.call(eventValidators, key) ? eventValidators[key as keyof typeof eventValidators] : isEvent;
}

/** @ignore */
export function nodeRemovedHook(node: PreactElement) {
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

/** @ignore */
export function validateClientEventArgs(args: unknown[]): args is [any, number?] {
	switch (args.length) {
		case 1:
			return true;
		case 2:
			return typeof args[1] === "number";
		default:
			return false;
	}
}

/** @mobius:shared */
