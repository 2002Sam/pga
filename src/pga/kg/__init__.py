"""The fact graph (after getzep/graphiti, Apache-2.0): entities and facts read out of your conversations, each fact
with when it held; a newer fact that contradicts an older one invalidates it instead of deleting it. See service.py;
the parts copied from graphiti (prompts, entity dedup, temporal rules, RRF) are in prompts.py, dedup.py, temporal.py
and search.py, each with graphiti's notice and what PGA changed."""
