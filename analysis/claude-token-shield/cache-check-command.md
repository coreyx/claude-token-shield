# /cache-check
 
## Passive Mode
 
/cache-check
 
Uses only local information.
 
Displays:
 
- cache health
- cache confidence
- idle duration
- model change detection
- MCP change detection
- plugin change detection
- configuration change detection
- recommendation
 
## Verbose Mode
 
/cache-check --verbose
 
Displays:
 
- timeline
- historical cache behavior
- environment deltas
- confidence rationale
 
## Probe Mode
 
/cache-check --probe
 
Sends a tiny request.
 
Measures:
 
- cache reads
- uncached input
- cache reuse percentage
 
Returns:
 
- hit confidence
- recommendation
 
## Deep Probe
 
/cache-check --probe deep
 
Runs multiple tiny probes.
 
Evaluates:
 
- cache consistency
- cache stability
- likely behavior for large prompts