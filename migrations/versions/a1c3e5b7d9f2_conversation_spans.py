"""conversation spans: agent_conversations.spans (when an imported conversation was actually going on)

Revision ID: a1c3e5b7d9f2
Revises: e8a0c2d4f6b3
Create Date: 2026-10-20 03:00:00

"""
from typing import Sequence, Union

from alembic import op
import sqlalchemy as sa
from sqlalchemy.dialects import postgresql

revision: str = 'a1c3e5b7d9f2'
down_revision: Union[str, Sequence[str], None] = 'e8a0c2d4f6b3'
branch_labels: Union[str, Sequence[str], None] = None
depends_on: Union[str, Sequence[str], None] = None


def upgrade() -> None:
    op.add_column('agent_conversations', sa.Column('spans', sa.JSON().with_variant(postgresql.JSONB(), "postgresql"), nullable=True))


def downgrade() -> None:
    op.drop_column('agent_conversations', 'spans')
