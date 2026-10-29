#!/usr/bin/env node
// Version-pinned trust checkout only. Installation/execution is separately authorized.
import { controllerMain } from '../dist/selfhost/promotion-controller.js';
process.exitCode = await controllerMain(process.argv.slice(2), process.env);
