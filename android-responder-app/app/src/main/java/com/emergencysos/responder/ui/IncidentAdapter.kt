package com.emergencysos.responder.ui

import android.graphics.Color
import android.view.LayoutInflater
import android.view.ViewGroup
import androidx.recyclerview.widget.RecyclerView
import com.emergencysos.responder.data.Incident
import com.emergencysos.responder.databinding.ItemIncidentBinding

class IncidentAdapter(
    private val onActionClick: (Incident, String) -> Unit,
    private val onItemClick: (Incident) -> Unit
) : RecyclerView.Adapter<IncidentAdapter.IncidentViewHolder>() {

    private val items = mutableListOf<Incident>()

    fun submitList(newItems: List<Incident>) {
        items.clear()
        items.addAll(newItems)
        notifyDataSetChanged()
    }

    override fun onCreateViewHolder(parent: ViewGroup, viewType: Int): IncidentViewHolder {
        val binding = ItemIncidentBinding.inflate(LayoutInflater.from(parent.context), parent, false)
        return IncidentViewHolder(binding)
    }

    override fun onBindViewHolder(holder: IncidentViewHolder, position: Int) {
        holder.bind(items[position])
    }

    override fun getItemCount(): Int = items.size

    inner class IncidentViewHolder(private val binding: ItemIncidentBinding) :
        RecyclerView.ViewHolder(binding.root) {

        fun bind(incident: Incident) {
            binding.tvIncidentId.text = incident.id
            binding.tvIncidentCategory.text = incident.categoryId?.replaceFirstChar { it.uppercase() } ?: "Emergency"
            binding.tvIncidentPriority.text = incident.priority.uppercase()

            val loc = incident.location
            binding.tvIncidentLocation.text = "⌖ ${loc?.building ?: "Campus"} · ${loc?.floor ?: ""} · ${loc?.room ?: ""}".trim()
            binding.tvIncidentStudent.text = "${incident.studentName ?: "Student"} (${incident.studentId ?: ""})"

            // Format status badge
            val statusText = "● " + incident.status.replace("_", " ").lowercase().replaceFirstChar { it.uppercase() }
            binding.tvIncidentStatus.text = statusText

            when (incident.status) {
                "DEPARTMENT_NOTIFIED", "SOS_SENT" -> {
                    binding.tvIncidentStatus.setTextColor(Color.parseColor("#F59E0B")) // Warning Yellow
                    binding.btnCardAction.text = "Accept SOS"
                    binding.btnCardAction.isEnabled = true
                    binding.btnCardAction.setOnClickListener { onActionClick(incident, "accept") }
                }
                "ACCEPTED" -> {
                    binding.tvIncidentStatus.setTextColor(Color.parseColor("#3B82F6")) // Blue
                    binding.btnCardAction.text = "Responding →"
                    binding.btnCardAction.isEnabled = true
                    binding.btnCardAction.setOnClickListener { onActionClick(incident, "respond") }
                }
                "RESPONDING" -> {
                    binding.tvIncidentStatus.setTextColor(Color.parseColor("#8B5CF6")) // Purple
                    binding.btnCardAction.text = "Mark Arrived"
                    binding.btnCardAction.isEnabled = true
                    binding.btnCardAction.setOnClickListener { onActionClick(incident, "arrive") }
                }
                "ARRIVED" -> {
                    binding.tvIncidentStatus.setTextColor(Color.parseColor("#10B981")) // Green
                    binding.btnCardAction.text = "Resolve"
                    binding.btnCardAction.isEnabled = true
                    binding.btnCardAction.setOnClickListener { onActionClick(incident, "resolve") }
                }
                "RESOLVED" -> {
                    binding.tvIncidentStatus.setTextColor(Color.parseColor("#64748B")) // Slate
                    binding.btnCardAction.text = "Resolved"
                    binding.btnCardAction.isEnabled = false
                }
                else -> {
                    binding.tvIncidentStatus.setTextColor(Color.parseColor("#94A3B8"))
                    binding.btnCardAction.text = "Details"
                    binding.btnCardAction.isEnabled = true
                    binding.btnCardAction.setOnClickListener { onItemClick(incident) }
                }
            }

            binding.root.setOnClickListener { onItemClick(incident) }
        }
    }
}
