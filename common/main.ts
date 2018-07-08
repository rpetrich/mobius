/** @ignore */

import app from "app";
import { _preactOptions, _rootElement } from "dom";
import { ComponentChild, render } from "preact";

// Validate that app module's default export is a valid component
const rootComponent = app as ComponentChild;
render(rootComponent, _rootElement, _rootElement.children[0], _preactOptions);
