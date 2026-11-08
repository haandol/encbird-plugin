#!/usr/bin/env bun
import { runCli } from '../../../dist/cli.js';

process.exitCode = await runCli();
