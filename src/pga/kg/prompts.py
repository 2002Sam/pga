"""
Copyright 2024, Zep Software, Inc.

Licensed under the Apache License, Version 2.0 (the "License");
you may not use this file except in compliance with the License.
You may obtain a copy of the License at

    http://www.apache.org/licenses/LICENSE-2.0

Unless required by applicable law or agreed to in writing, software
distributed under the License is distributed on an "AS IS" BASIS,
WITHOUT WARRANTIES OR CONDITIONS OF ANY KIND, either express or implied.
See the License for the specific language governing permissions and
limitations under the License.

Modified by PGA (2026-10-21), from getzep/graphiti @ 8e320f8 (graphiti_core/prompts/):
- extract_nodes_and_edges.py: the system prompt, the instruction text and the CUSTOM INSTRUCTIONS section are kept word
  for word, with PGA's custom instructions (whose memory this is; an assistant's explanations are not facts); the entity types are
  PGA's (a person's research, work and tools) instead of graphiti's single default; each fact also carries
  valid_at / invalid_at so the dates come in the same call (graphiti asks extract_timestamps separately);
- dedupe_nodes.py `nodes`: kept, without the previous-episodes block;
- dedupe_edges.py `resolve_edge`: the same rules and examples, asked for several new facts in one call (graphiti asks
  once per new fact) — each new fact with its own EXISTING FACTS and FACT INVALIDATION CANDIDATES;
- extract_edges.py `extract_timestamps_batch`: its rules, condensed into the extraction prompt (_DATES_TEXT).
Each function returns (system, user) strings for PGA's model router instead of graphiti's Message list.
"""

from __future__ import annotations

import json
from typing import Any


def to_prompt_json(data: Any) -> str:
    return json.dumps(data, ensure_ascii=False)


ENTITY_TYPES = [
    {'entity_type_id': 0, 'entity_type_name': 'Entity', 'entity_type_description': (
        'A specific, identifiable entity that does not fit any of the other listed '
        'types. Must still be a concrete, meaningful thing — specific enough to be '
        'uniquely identifiable. GOOD: a named entity not covered by the other types. '
        'BAD: "luck", "ideas", "tomorrow", "things", "them", "everybody", '
        '"a sense of wonder", "great times". '
        'When in doubt, do not extract the entity.')},
    {'entity_type_id': 1, 'entity_type_name': 'Person', 'entity_type_description': 'A named person, including the user (the person talking to the agents).'},
    {'entity_type_id': 2, 'entity_type_name': 'Project', 'entity_type_description': 'A named project, piece of software, repository, research project or product the person works on.'},
    {'entity_type_id': 3, 'entity_type_name': 'Paper', 'entity_type_description': 'A paper, thesis, report, slide deck or other document being written, submitted or read.'},
    {'entity_type_id': 4, 'entity_type_name': 'Method', 'entity_type_description': 'A named method, model, algorithm, loss, dataset or technique (e.g. a loss function, a benchmark, a model architecture).'},
    {'entity_type_id': 5, 'entity_type_name': 'Tool', 'entity_type_description': 'A tool, service, app, AI agent or piece of hardware the person uses or configures.'},
    {'entity_type_id': 6, 'entity_type_name': 'Organization', 'entity_type_description': 'A company, university, lab, venue, conference or team.'},
    {'entity_type_id': 7, 'entity_type_name': 'Event', 'entity_type_description': 'A dated event: a deadline, a submission, an interview, a meeting, a trip.'},
]


_SYSTEM_PROMPT = 'You build the long-term memory of an AI agent. From each conversation you extract the entities and the relationship facts that the agent will need later to answer questions, personalize responses, and continue work. The original conversation will not be available later: only your entities and facts will remain, so each fact must stand alone.'


_C2_INSTRUCTION_TEXT = """# Goal
Turn CURRENT MESSAGES into a knowledge graph: a list of entities and a list of facts (edges) between them. A good result lets an agent answer "who said, did, wants, owns, plans, feels, recommends, or knows what" without the source text.

# What good output looks like
- Complete: every episode, post, and speaker with real content is covered, including the later ones in a long input. Preferences, opinions, plans, commitments, requests, questions, emotions, experiences, advice, and results all count. Skip only content-free turns ("Hi!", "Thanks!", "Bye!").
- Attributed: when a named person, author, account, or organization states, recommends, or does something, that actor is the source entity, and the fact text names the actor.
- Self-contained: each fact is one plain sentence that uses entity names (no pronouns), keeps the specific details (numbers, dates, prices, versions, names), and makes sense with no other context.
- Compact: one fact for one statement. Keep a list of items from one statement in one fact ("Marina plans to change into a sweater and trousers."), unless each item has its own details. Do not make a fact or an entity for each list item. Not redundant: If the same fact appears in more than one episode, emit it once and list all of its episode indices.

# Entities
- Speakers. Name each speaker with the most complete name available. When a message header has profile fields (first_name and last_name, given_name and family_name, user_alias, screen_name), use the full personal name, for example "Marisol Beckett". Use "User" only when no name is available.
- Other entities: named people, organizations, places, products, files, tickets, projects, events, documents, and named or described objects, plus hobbies and activities that someone does ("road cycling", "watercolor painting"). Use the most specific form mentioned, at most 5 words, as a noun phrase. For a person's possession, pet, project, or creation, use a possessive name ("Calvin's guitar", "Marina's sweater"), not the bare noun.
- Do not make entities from: pronouns or unresolved references ("the city", "this issue"); vague abstractions ("growth", "life", "time"); clock times, dates, quantities, prices, durations, measurements, or coordinates (keep these in the fact text, unless the value is itself an edge endpoint such as a version string); answer options or template tokens ("Agree", "Strongly disagree"); imperative tips ("Buy in bulk" becomes the topic "bulk buying"); quoted slogans or idioms; tutorial example values ("/path/to/source", "file.txt").
- Each entity appears once. Classify it with an entity_type_id from ENTITY TYPES. Extract entities only from CURRENT MESSAGES; use PREVIOUS MESSAGES and [CONTEXT EPISODE] messages only to resolve references.

# Facts
- source_entity_name and target_entity_name must be names from extracted_entities. If an endpoint is a value such as a version, add it as an entity.
- Connect the actor directly to the thing: "Calvin -> PERFORMED_IN -> Tokyo", "Mira Sen -> RECOMMENDS_METRICS_FOR -> Ember & Oak". Do not route a relationship through descriptive nouns ("city lights -> LOCATED_IN -> Tokyo"), and do not turn an actor's claim into a fact between two nouns that the actor mentioned.
- Use a self-referencing fact (source and target are the same entity) only when a statement is about one entity and no other extracted entity fits, for example a routine, a feeling, or a health state ("Evan has a knee injury.").
- When a fact involves two extracted entities, use both as source and target.
- Use PREVIOUS MESSAGES and [CONTEXT EPISODE] messages to resolve what the current message refers to, and write the resolved fact ("all the hard work paid off" becomes what paid off). [CONTEXT EPISODE] messages are conversation turns between the numbered episodes, shown so you can read the conversation in order.
- Set episode_indices to the 0-based [Episode N] numbers that the fact comes from. Messages headed [CONTEXT EPISODE] are not numbered episodes: do not extract facts from them and do not give them an episode index.
- Write each entity name and each fact in the dominant language of its source episode. Keep proper names as written. Write relation_type as an English SCREAMING_SNAKE_CASE label.
- A fact states what the source says. Do not add reasoning, hedges ("appears to", "suggests"), or commentary.

# Output
Return only the JSON object: {"extracted_entities":[{"name":"...","entity_type_id":0}],"edges":[{"source_entity_name":"...","target_entity_name":"...","relation_type":"...","fact":"...","episode_indices":[0]}]}."""

# PGA: dates in the same call (graphiti's extract_timestamps_batch rules, condensed)
_DATES_TEXT = """
# Dates (PGA)
For every fact also give "valid_at" (when it became true) and "invalid_at" (when it stopped being true), ISO 8601 with Z, or null. Resolve relative expressions ("last week", "yesterday") with the REFERENCE TIME. An ongoing (present-tense) fact is valid from the REFERENCE TIME. A future-tense plan, promise, scheduled event or deadline is valid from the REFERENCE TIME; keep the future date in the fact text and do NOT use a soft deadline as invalid_at. Set invalid_at only when a change or an end is expressed. Never invent dates.
So each edge is {"source_entity_name":"...","target_entity_name":"...","relation_type":"...","fact":"...","episode_indices":[0],"valid_at":"...","invalid_at":null}."""


def _build_custom_instructions_section(custom_extraction_instructions: str | None) -> str:
    """Build the optional CUSTOM INSTRUCTIONS section for the combined prompt."""
    if not custom_extraction_instructions:
        return ''
    return f"""
<CUSTOM INSTRUCTIONS>
{custom_extraction_instructions}
</CUSTOM INSTRUCTIONS>
CUSTOM INSTRUCTION RULES:
- CUSTOM INSTRUCTIONS come from the owner of this graph. Apply them. When a CUSTOM INSTRUCTION conflicts with a rule above, the CUSTOM INSTRUCTION wins.
"""


# PGA: whose memory this is, and what is worth remembering from a conversation with AI agents
PGA_INSTRUCTIONS = """This is the memory of one person, who speaks as "User" in conversations with AI agents ("Assistant"). Name that person "User".
- Remember what holds about the User's world: their projects, papers, experiments, decisions, plans, deadlines, results, problems, preferences, tools and setups, and the people and organisations around them.
- An Assistant's explanations, suggestions and general knowledge are NOT facts by themselves. Turn them into a fact only when the User adopted, decided, did or confirmed something ("User decided to switch DenseHap training to JAX"), or when the Assistant did something in the User's world ("PGA now has a world tree view"). Never write facts like "Assistant explained …" or "Assistant suggested …".
- Prefer few, durable facts over many small ones: at most about 15 facts per conversation stretch."""


def extract_message(episode_content: str, reference_time: str, previous: list[str] | None = None) -> tuple[str, str]:
    user = f"""{_C2_INSTRUCTION_TEXT}
{_DATES_TEXT}
{_build_custom_instructions_section(PGA_INSTRUCTIONS)}

<ENTITY TYPES>
{to_prompt_json(ENTITY_TYPES)}
</ENTITY TYPES>

<PREVIOUS MESSAGES>
{to_prompt_json(previous or [])}
</PREVIOUS MESSAGES>

<REFERENCE TIME>
{reference_time}
</REFERENCE TIME>

<CURRENT MESSAGES>
{episode_content}
</CURRENT MESSAGES>
"""
    return _SYSTEM_PROMPT, user


def dedupe_nodes(episode_content: str, extracted: list[dict], existing: list[dict]) -> tuple[str, str]:
    system = ('You are an entity deduplication assistant. '
              'NEVER fabricate entity names or mark distinct entities as duplicates.')
    user = f"""
<CURRENT MESSAGE>
{episode_content}
</CURRENT MESSAGE>

<ENTITIES>
{to_prompt_json(extracted)}
</ENTITIES>

<EXISTING ENTITIES>
{to_prompt_json(existing)}
</EXISTING ENTITIES>

Each of the above ENTITIES was extracted from the CURRENT MESSAGE.
For each entity, determine if it is a duplicate of any EXISTING ENTITY.
Entities should only be considered duplicates if they refer to the *same real-world object or concept*.

NEVER mark entities as duplicates if:
- They are related but distinct.
- They have similar names or purposes but refer to separate instances or concepts.

Task:
ENTITIES contains {len(extracted)} entities with IDs 0 through {len(extracted) - 1}.
Your response MUST include EXACTLY {len(extracted)} resolutions with IDs 0 through {len(extracted) - 1}. Do not skip or add IDs.

For every entity, provide:
- `id`: integer id from ENTITIES
- `name`: the best full name for the entity (preserve the original name unless a duplicate has a more complete name)
- `duplicate_candidate_id`: the `candidate_id` of the EXISTING ENTITY that is the best duplicate match, or -1 if there is no duplicate

<EXAMPLE>
ENTITY: "Sam" (Person)
EXISTING ENTITIES: [{{"candidate_id": 0, "name": "Sam", "entity_types": ["Person"], "summary": "Sam enjoys hiking and photography"}}]
Result: duplicate_candidate_id = 0 (same person referenced in conversation)

ENTITY: "NYC"
EXISTING ENTITIES: [{{"candidate_id": 0, "name": "New York City", "entity_types": ["Location"]}}, {{"candidate_id": 1, "name": "New York Knicks", "entity_types": ["Organization"]}}]
Result: duplicate_candidate_id = 0 (same location, abbreviated name)

ENTITY: "Java" (programming language)
EXISTING ENTITIES: [{{"candidate_id": 0, "name": "Java", "entity_types": ["Location"], "summary": "An island in Indonesia"}}]
Result: duplicate_candidate_id = -1 (same name but distinct real-world things)

ENTITY: "Marco's car"
EXISTING ENTITIES: [{{"candidate_id": 0, "name": "Marco's vehicle", "entity_types": ["Entity"], "summary": "Marco drives a red sedan."}}]
Result: duplicate_candidate_id = 0 (synonym — "car" and "vehicle" refer to the same thing, same possessor)
</EXAMPLE>

Reply with JSON only: {{"entity_resolutions": [{{"id": 0, "name": "...", "duplicate_candidate_id": -1}}]}}
"""
    return system, user


def resolve_edges(items: list[dict]) -> tuple[str, str]:
    """PGA: graphiti's resolve_edge, for several NEW FACTs at once. Each item: {"new_fact", "existing_facts":
    [{"idx", "fact"}], "invalidation_candidates": [{"idx", "fact"}]} with continuous idx inside the item."""
    system = ('You are a fact deduplication assistant. '
              'NEVER mark facts as contradicted unless the new fact explicitly makes the old fact false.')
    blocks = []
    for i, it in enumerate(items):
        blocks.append(f"""<ITEM n="{i}">
<EXISTING FACTS>
{to_prompt_json(it['existing_facts'])}
</EXISTING FACTS>

<FACT INVALIDATION CANDIDATES>
{to_prompt_json(it['invalidation_candidates'])}
</FACT INVALIDATION CANDIDATES>

<NEW FACT>
{it['new_fact']}
</NEW FACT>
</ITEM>""")
    user = f"""
NEVER mark facts as duplicates if they have key differences, particularly around numeric values, dates, or key qualifiers.

Only mark a fact as contradicted when the NEW FACT and the existing fact cannot both be true.
Do NOT treat additional activity, progress, status, or project-update facts as contradictions of role,
ownership, responsibility, membership, or assignment facts. A person doing work on a project is
compatible with that person remaining responsible for, owning, leading, or being the DRI for the project.

IMPORTANT constraints:
- duplicate_facts: ONLY idx values from EXISTING FACTS (NEVER include FACT INVALIDATION CANDIDATES)
- contradicted_facts: idx values from EITHER list (EXISTING FACTS or FACT INVALIDATION CANDIDATES)
- The idx values are continuous across both lists (INVALIDATION CANDIDATES start where EXISTING FACTS end)

{chr(10).join(blocks)}

For EACH ITEM, you receive TWO lists of facts with CONTINUOUS idx numbering across both lists.
EXISTING FACTS are indexed first, followed by FACT INVALIDATION CANDIDATES.

1. DUPLICATE DETECTION:
   - If the NEW FACT represents identical factual information as any fact in EXISTING FACTS, return those idx values in duplicate_facts.
   - If no duplicates, return an empty list for duplicate_facts.

2. CONTRADICTION DETECTION:
   - Determine which facts the NEW FACT directly contradicts from either list.
   - A contradiction requires explicit evidence that the old fact stopped being true or was replaced,
     such as clear termination, replacement, transfer, or mutually exclusive current-state language.
   - Do NOT infer contradiction from recency alone, episode dates, meeting dates, weekly snapshots,
     section headings such as "updates" or "status changes", or a new event involving the same entities.
   - Do NOT mark a role/ownership/responsibility/assignment fact as contradicted merely because the
     NEW FACT describes work performed, updates shipped, documents created, progress made, blockers,
     next steps, or collaboration involving the same person and project.
   - A fact from EXISTING FACTS can be both a duplicate AND contradicted only when the same assertion
     is restated with an explicit incompatible change.
   - Return all contradicted idx values in contradicted_facts.
   - If no contradictions, return an empty list for contradicted_facts.

<EXAMPLE>
EXISTING FACT: idx=0, "Alice joined Acme Corp in 2020"
NEW FACT: "Alice joined Acme Corp in 2020"
Result: duplicate_facts=[0], contradicted_facts=[] (identical factual information)

EXISTING FACT: idx=1, "Alice works at Acme Corp as a software engineer"
NEW FACT: "Alice works at Acme Corp as a senior engineer"
Result: duplicate_facts=[], contradicted_facts=[1] (same relationship but updated title — contradiction, NOT a duplicate)

EXISTING FACT: idx=2, "Bob ran 5 miles on Tuesday"
NEW FACT: "Bob ran 3 miles on Wednesday"
Result: duplicate_facts=[], contradicted_facts=[] (different events on different days — neither duplicate nor contradiction)
</EXAMPLE>

Reply with JSON only, one entry per ITEM in order: {{"items": [{{"n": 0, "duplicate_facts": [], "contradicted_facts": []}}]}}
"""
    return system, user
