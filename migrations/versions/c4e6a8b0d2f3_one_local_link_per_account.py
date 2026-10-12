"""one link per account for each agent read from this machine

Revision ID: c4e6a8b0d2f3
Revises: b3d5f7a9c1e2
Create Date: 2026-10-12 21:30:00

"""
from typing import Sequence, Union

from alembic import op
import sqlalchemy as sa

revision: str = 'c4e6a8b0d2f3'
down_revision: Union[str, Sequence[str], None] = 'b3d5f7a9c1e2'
branch_labels: Union[str, Sequence[str], None] = None
depends_on: Union[str, Sequence[str], None] = None

LOCAL = "connector in ('claude_code', 'hermes', 'codex', 'workbuddy', 'codebuddy')"


def upgrade() -> None:
    # keep the oldest link of each local agent per account; a racing sync may have added a second
    op.execute(f"""delete from linked_agents a using linked_agents b
                   where a.user_id = b.user_id and a.connector = b.connector and a.{LOCAL.replace('connector', 'connector', 1)}
                     and (a.created_at, a.id) > (b.created_at, b.id)""")
    op.create_index('uq_linked_agents_local', 'linked_agents', ['user_id', 'connector'], unique=True,
                    postgresql_where=sa.text(LOCAL))


def downgrade() -> None:
    op.drop_index('uq_linked_agents_local', table_name='linked_agents')
