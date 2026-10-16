"""thought tree for your own conversations: thought_nodes.scope (aim | user), aim_id nullable

Revision ID: d7f9b1c3e5a2
Revises: c6e8a0b2d4f1
Create Date: 2026-10-17 00:40:00

"""
from typing import Sequence, Union

from alembic import op
import sqlalchemy as sa

revision: str = 'd7f9b1c3e5a2'
down_revision: Union[str, Sequence[str], None] = 'c6e8a0b2d4f1'
branch_labels: Union[str, Sequence[str], None] = None
depends_on: Union[str, Sequence[str], None] = None


def upgrade() -> None:
    op.add_column('thought_nodes', sa.Column('scope', sa.String(length=16), nullable=False, server_default='aim'))
    op.alter_column('thought_nodes', 'aim_id', existing_type=sa.Uuid(), nullable=True)


def downgrade() -> None:
    op.execute("DELETE FROM thought_nodes WHERE aim_id IS NULL")
    op.alter_column('thought_nodes', 'aim_id', existing_type=sa.Uuid(), nullable=False)
    op.drop_column('thought_nodes', 'scope')
