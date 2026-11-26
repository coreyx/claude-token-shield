# Cache Confidence Engine
 
The cache system should estimate probability rather than claim certainty.
 
Inputs:
 
- idle time
- previous cache hits
- previous cache misses
- model changes
- MCP changes
- plugin changes
- configuration changes
- Claude version changes
- session resume events
- usage telemetry
 
Outputs:
 
- Cache Health Score (0-100)
- Confidence Level
- State Classification
 
States:
 
HOT
WARM
COOLING
RISKY
STALE
 
Example:
 
Health: 84%
State: WARM
 
Health: 47%
State: RISKY
 
Health: 12%
State: STALE