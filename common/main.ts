import { _rootElement, _preactOptions } from "dom";
import { render, ComponentChild } from "preact";
import app from "app";

// Validate that app module's default export is a valid component
const rootComponent = app as ComponentChild;
render(rootComponent, _rootElement, _rootElement.children[0], _preactOptions);
