export const defaultEventProperties = {
	altKey: false,
	button: 0,
	buttons: 0,
	ctrlKey: false,
	metaKey: false,
	shiftKey: false,
	repeat: false,
};

export type EventArgs = [JSX.Event | JSX.ClipboardEvent | JSX.CompositionEvent | JSX.DragEvent | JSX.FocusEvent | JSX.KeyboardEvent | JSX.MouseEvent | JSX.TouchEvent | JSX.UIEvent | JSX.WheelEvent | JSX.AnimationEvent | JSX.TransitionEvent];

export const registeredListeners: { [ eventId: number ]: (event: any) => void } = {};
